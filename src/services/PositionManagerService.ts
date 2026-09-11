import { watchlistService } from "./WatchlistService.ts";
import { tradeExecutionService } from "./TradeExecutionService.ts";
import { getTakeProfitPct, getStopLossPct, getTrailingStopPct, getStalePositionMinutes, getPositionCheckIntervalMs } from "../utils/env.ts";

export class PositionManagerService {
  private runtime: any;
  private checkInterval: any;
  private positionPeaks: Map<string, number>; // mint -> peak price

  constructor(runtime) {
    this.runtime = runtime;
    this.positionPeaks = new Map();
  }

  start() {
    this.runtime.logger.info("[PositionManager] Starting position manager...");
    
    // Initial check
    this.checkPositions();
    
    // Set up periodic checks
    const interval = getPositionCheckIntervalMs();
    this.checkInterval = setInterval(() => {
      this.checkPositions();
    }, interval);

    this.runtime.logger.info(`[PositionManager] Checking positions every ${interval}ms`);
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  private async checkPositions() {
    try {
      const positions = await watchlistService.getOpenPositions();
      
      for (const position of positions) {
        try {
          await this.evaluatePosition(position);
        } catch (e) {
          this.runtime.logger.error(`[PositionManager] Error evaluating ${position.symbol}:`, e);
        }
      }
    } catch (e) {
      this.runtime.logger.error("[PositionManager] Error in position check loop:", e);
    }
  }

  private async evaluatePosition(position) {
    const mint = position.mint_address;
    const symbol = position.symbol || mint;
    
    // Fetch current price
    const currentPrice = await this.getTokenPrice(mint);
    if (!currentPrice || currentPrice === 0) {
      return;
    }

    // Update peak price
    if (!this.positionPeaks.has(mint) || currentPrice > this.positionPeaks.get(mint)) {
      this.positionPeaks.set(mint, currentPrice);
      await watchlistService.updatePeakPrice(mint, currentPrice);
    }

    const entryPrice = position.entry_price_usd || currentPrice;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const peakPrice = this.positionPeaks.get(mint) || currentPrice;
    const trailingStopDistance = ((peakPrice - currentPrice) / peakPrice) * 100;
    
    // Calculate position age in minutes
    const enteredAt = new Date(position.entered_at);
    const ageMinutes = (Date.now() - enteredAt.getTime()) / (1000 * 60);

    // Check exit conditions
    const takeProfitPct = getTakeProfitPct();
    const stopLossPct = getStopLossPct();
    const trailingStopPct = getTrailingStopPct();
    const staleMinutes = getStalePositionMinutes();

    if (pnlPct >= takeProfitPct) {
      this.runtime.logger.info(`[PositionManager] TAKE_PROFIT triggered for ${symbol} (+${pnlPct.toFixed(1)}%)`);
      await this.exitPosition(mint, symbol, `TAKE_PROFIT (+${pnlPct.toFixed(1)}%)`, currentPrice, pnlPct);
    } else if (pnlPct <= -stopLossPct) {
      this.runtime.logger.info(`[PositionManager] STOP_LOSS triggered for ${symbol} (${pnlPct.toFixed(1)}%)`);
      await this.exitPosition(mint, symbol, `STOP_LOSS (${pnlPct.toFixed(1)}%)`, currentPrice, pnlPct);
    } else if (trailingStopDistance >= trailingStopPct && peakPrice > entryPrice) {
      this.runtime.logger.info(`[PositionManager] TRAILING_STOP triggered for ${symbol} (${trailingStopDistance.toFixed(1)}% below peak)`);
      await this.exitPosition(mint, symbol, `TRAILING_STOP (${trailingStopDistance.toFixed(1)}% below peak)`, currentPrice, pnlPct);
    } else if (ageMinutes > staleMinutes && pnlPct < 10) {
      this.runtime.logger.info(`[PositionManager] STALE_POSITION triggered for ${symbol} (${ageMinutes.toFixed(0)} min, ${pnlPct.toFixed(1)}%)`);
      await this.exitPosition(mint, symbol, `STALE_POSITION (${ageMinutes.toFixed(0)} min)`, currentPrice, pnlPct);
    } else {
      this.runtime.logger.debug(`[PositionManager] ${symbol}: PnL ${pnlPct.toFixed(1)}%, Age ${ageMinutes.toFixed(0)}min, Peak ${peakPrice.toFixed(6)}`);
    }
  }

  private async exitPosition(mint: string, symbol: string, reason: string, exitPrice: number, pnlPct: number) {
    this.runtime.logger.info(`[PositionManager] Exiting position ${symbol} - ${reason}`);

    // Execute sell
    const result = await tradeExecutionService.executeSell(mint, symbol, reason);

    if (result.success) {
      // Calculate realized PnL in USD
      const position = await watchlistService.getOpenPositions();
      const pos = position.find(p => p.mint_address === mint);
      const amountSol = pos ? pos.amount_sol : 0;
      const realizedPnl = amountSol * (pnlPct / 100);

      // Update position status
      await watchlistService.updatePositionStatus(
        mint,
        "CLOSED",
        exitPrice,
        realizedPnl,
        result.txSignature
      );

      // Emit event for Telegram telemetry
      this.runtime.logger.info(`[PositionManager] ${symbol} closed. PnL: ${pnlPct.toFixed(1)}% ($${realizedPnl.toFixed(2)})`);

      const signal = {
        event: "POSITION_CLOSED",
        mint_address: mint,
        symbol: symbol,
        reason: reason,
        exit_price_usd: exitPrice,
        pnl_pct: pnlPct,
        realized_pnl_usd: realizedPnl,
        tx_signature: result.txSignature,
        dry_run: result.dryRun
      };

      const channel = this.runtime.getRoom("warmroom");
      if (channel) {
        channel.publish({
          author: { name: "Gamma" },
          text: JSON.stringify(signal),
          timestamp: Date.now()
        });
      }

      this.runtime.emitEvent("gamma_position_closed", signal);

      // Clear peak price
      this.positionPeaks.delete(mint);
    } else {
      this.runtime.logger.error(`[PositionManager] Failed to exit ${symbol}: ${result.error}`);
    }
  }

  private async getTokenPrice(mint: string): Promise<number> {
    try {
      // Try Jupiter Price API
      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (jupiterService && jupiterService.getTokenPrice) {
        return await jupiterService.getTokenPrice(mint);
      }

      // Fallback to DexScreener
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (response.ok) {
        const data = await response.json();
        const pair = data?.pair?.[0];
        if (pair && pair.priceUsd) {
          return parseFloat(pair.priceUsd);
        }
      }
    } catch (e) {
      this.runtime.logger.error(`[PositionManager] Error fetching price for ${mint}:`, e);
    }

    return 0;
  }
}

export const positionManagerService = new PositionManagerService(null);
export default positionManagerService;