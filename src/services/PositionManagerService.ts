import { watchlistService } from "./WatchlistService.ts";
import { tradeExecutionService } from "./TradeExecutionService.ts";
import { configService } from "./ConfigService.ts";
import { logger } from "./LoggerService.ts";

export class PositionManagerService {
  private runtime: any;
  private checkInterval: any;
  private positionPeaks: Map<string, number>; // mint -> peak price

  constructor(runtime) {
    this.runtime = runtime;
    this.positionPeaks = new Map();
  }

  start() {
    logger.info("POSITIONS", "PositionManager", "Starting position manager...");

    // Initial check
    this.checkPositions();

    // Set up periodic checks
    const interval = configService.getNumber("POSITION_CHECK_INTERVAL_MS");
    this.checkInterval = setInterval(() => {
      this.checkPositions();
    }, interval);

    logger.info("POSITIONS", "PositionManager", "Position check interval configured", {
      intervalMs: interval,
    });
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    logger.info("POSITIONS", "PositionManager", "Position manager stopped");
  }

  private async checkPositions() {
    try {
      // Only manage positions matching current mode (dry run vs live)
      const isDryRun = configService.getBoolean("DRY_RUN_MODE");
      const currentMode = isDryRun ? "DRY_RUN" : "LIVE";
      const positions = await watchlistService.getOpenPositions(isDryRun);
      logger.debug("POSITIONS", "PositionManager", "Checking positions", {
        count: positions.length,
        mode: currentMode,
      });

      for (const position of positions) {
        try {
          await this.evaluatePosition(position);
        } catch (e) {
          logger.error("POSITIONS", "PositionManager", "Error evaluating position", {
            symbol: position.symbol,
            error: e.message,
          });
        }
      }
    } catch (e) {
      logger.error("POSITIONS", "PositionManager", "Error in position check loop", {
        error: e.message,
      });
    }
  }

  private async evaluatePosition(position) {
    const mint = position.mint_address;
    const symbol = position.symbol || mint;

    // Calculate position age first (independent of price)
    const enteredAt = new Date(position.entered_at);
    const ageMinutes = (Date.now() - enteredAt.getTime()) / (1000 * 60);
    const staleMinutes = configService.getNumber("STALE_POSITION_MINUTES");

    // Fetch current price
    const currentPrice = await this.getTokenPrice(mint);
    if (!currentPrice || currentPrice === 0) {
      logger.debug("POSITIONS", "PositionManager", "Could not fetch price, skipping", {
        symbol,
        mint,
      });
      // Still check stale even if we can't get a price
      if (ageMinutes > staleMinutes) {
        logger.info("POSITIONS", "PositionManager", "STALE_POSITION triggered (no price)", {
          symbol,
          ageMinutes: ageMinutes.toFixed(0),
          staleMinutes,
        });
        await this.exitPosition(mint, symbol, `STALE_POSITION (${ageMinutes.toFixed(0)} min)`, 0, 0);
      }
      return;
    }

    // Update peak price
    if (!this.positionPeaks.has(mint) || currentPrice > this.positionPeaks.get(mint)) {
      this.positionPeaks.set(mint, currentPrice);
      await watchlistService.updatePeakPrice(mint, currentPrice);
      logger.debug("POSITIONS", "PositionManager", "Peak price updated", {
        symbol,
        peakPrice: currentPrice,
      });
    }

    const entryPrice = position.entry_price_usd || currentPrice;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const unrealizedPnlUsd = position.amount_sol * (currentPrice - entryPrice);
    const peakPrice = this.positionPeaks.get(mint) || currentPrice;
    const trailingStopDistance = ((peakPrice - currentPrice) / peakPrice) * 100;

    // Update position record with live price and unrealized PnL
    await watchlistService.updatePositionPrice(mint, currentPrice, unrealizedPnlUsd, pnlPct);

    // Check exit conditions
    const takeProfitPct = configService.getNumber("TAKE_PROFIT_PCT");
    const stopLossPct = configService.getNumber("STOP_LOSS_PCT");
    const trailingStopPct = configService.getNumber("TRAILING_STOP_PCT");

    if (pnlPct >= takeProfitPct) {
      logger.info("POSITIONS", "PositionManager", "TAKE_PROFIT triggered", {
        symbol,
        pnlPct: pnlPct.toFixed(1),
        takeProfitPct,
      });
      await this.exitPosition(mint, symbol, `TAKE_PROFIT (+${pnlPct.toFixed(1)}%)`, currentPrice, pnlPct);
    } else if (pnlPct <= -stopLossPct) {
      logger.info("POSITIONS", "PositionManager", "STOP_LOSS triggered", {
        symbol,
        pnlPct: pnlPct.toFixed(1),
        stopLossPct,
      });
      await this.exitPosition(mint, symbol, `STOP_LOSS (${pnlPct.toFixed(1)}%)`, currentPrice, pnlPct);
    } else if (trailingStopDistance >= trailingStopPct && peakPrice > entryPrice) {
      logger.info("POSITIONS", "PositionManager", "TRAILING_STOP triggered", {
        symbol,
        trailingStopDistance: trailingStopDistance.toFixed(1),
        trailingStopPct,
      });
      await this.exitPosition(
        mint,
        symbol,
        `TRAILING_STOP (${trailingStopDistance.toFixed(1)}% below peak)`,
        currentPrice,
        pnlPct
      );
    } else if (ageMinutes > staleMinutes && pnlPct < 10) {
      logger.info("POSITIONS", "PositionManager", "STALE_POSITION triggered", {
        symbol,
        ageMinutes: ageMinutes.toFixed(0),
        staleMinutes,
      });
      await this.exitPosition(mint, symbol, `STALE_POSITION (${ageMinutes.toFixed(0)} min)`, currentPrice, pnlPct);
    } else {
      logger.debug("POSITIONS", "PositionManager", "Position held", {
        symbol,
        pnlPct: pnlPct.toFixed(1),
        ageMinutes: ageMinutes.toFixed(0),
        peakPrice: peakPrice.toFixed(6),
      });
    }
  }

  private async exitPosition(
    mint: string,
    symbol: string,
    reason: string,
    exitPrice: number,
    pnlPct: number
  ) {
    logger.info("POSITIONS", "PositionManager", "Exiting position", {
      symbol,
      reason,
    });

    // Execute sell
    const result = await tradeExecutionService.executeSell(mint, symbol, reason);

    if (result.success) {
      // Calculate realized PnL in USD
      const openPositions = await watchlistService.getOpenPositions();
      const pos = openPositions.find((p) => p.mint_address === mint);
      const amountSol = pos ? pos.amount_sol : 0;
      const entryPrice = pos ? (pos.entry_price_usd || exitPrice) : exitPrice;
      const realizedPnl = amountSol * (exitPrice - entryPrice);

      // Update position status
      await watchlistService.updatePositionStatus(
        mint,
        "CLOSED",
        exitPrice,
        realizedPnl,
        result.txSignature
      );

      logger.info("POSITIONS", "PositionManager", "Position closed", {
        symbol,
        pnlPct: pnlPct.toFixed(1),
        realizedPnl: realizedPnl.toFixed(2),
        txSignature: result.txSignature,
      });

      const signal = {
        event: "POSITION_CLOSED",
        mint_address: mint,
        symbol: symbol,
        reason: reason,
        exit_price_usd: exitPrice,
        pnl_pct: pnlPct,
        realized_pnl_usd: realizedPnl,
        tx_signature: result.txSignature,
        dry_run: result.dryRun,
      };

      const channel = this.runtime?.getRoom?.("warmroom");
      if (channel) {
        channel.publish({
          author: { name: "Gamma" },
          text: JSON.stringify(signal),
          timestamp: Date.now(),
        });
      }

      this.runtime?.emitEvent?.("gamma_position_closed", signal);

      // Clear peak price
      this.positionPeaks.delete(mint);
    } else {
      logger.error("POSITIONS", "PositionManager", "Failed to exit position", {
        symbol,
        error: result.error,
      });
    }
  }

  private async getTokenPrice(mint: string): Promise<number> {
    try {
      // Try Jupiter Price API
      const jupiterService = this.runtime?.getService?.("JUPITER_SERVICE");
      if (jupiterService && jupiterService.getTokenPrice) {
        return await jupiterService.getTokenPrice(mint);
      }

      // Fallback to DexScreener
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (response.ok) {
        const data = await response.json();
        const pair = data?.pairs?.[0];
        if (pair && pair.priceUsd) {
          return parseFloat(pair.priceUsd);
        }
      }
    } catch (e) {
      logger.error("POSITIONS", "PositionManager", "Error fetching token price", {
        mint,
        error: e.message,
      });
    }

    return 0;
  }
}

export const positionManagerService = new PositionManagerService(null);
export default positionManagerService;