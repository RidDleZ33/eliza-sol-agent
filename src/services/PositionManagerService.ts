// PositionManagerService: sole exit engine. Gamma evaluator only makes entry decisions;
// this service independently checks open positions on its own interval and executes
// stop-loss, take-profit, and trailing-stop exits via executeSell.
import { watchlistService } from "./WatchlistService.ts";
import { tradeExecutionService } from "./TradeExecutionService.ts";
import { configService } from "./ConfigService.ts";
import { logger } from "./LoggerService.ts";
import { addSessionPnl } from "../execution/risk.ts";
import { priceActionService } from "./PriceActionService.ts";
import { volStopPct } from "../execution/volStop.ts";
import { excursionSnippet } from "../execution/excursion.ts";
import { getExitClockSec, getClockSecMigEdge, getPoolDropPct, getStallSec } from "../utils/env.ts";
import { loadRecipeById } from "../recipes/db.ts";

export class PositionManagerService {
  private runtime: any;
  private checkInterval: any;
  private positionPeaks: Map<string, number>; // mint -> peak price
  private positionTroughs: Map<string, number>; // mint -> trough price
  private positionPoolQuotes: Map<string, number>; // mint -> initial pool quote SOL
  private positionLastHighMs: Map<string, number>; // mint -> timestamp of last new high
  private exitSourceLog: Set<string>; // mints we've already logged exit source for

  constructor(runtime) {
    this.runtime = runtime;
    this.positionPeaks = new Map();
    this.positionTroughs = new Map();
    this.positionPoolQuotes = new Map();
    this.positionLastHighMs = new Map();
    this.exitSourceLog = new Set();
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
    const ageSeconds = (Date.now() - enteredAt.getTime()) / 1000;
    const staleMinutes = configService.getNumber("STALE_POSITION_MINUTES");

    // Load recipe exits before clock decision so clock_sec override works
    const recipeId = position.strategy_id;
    let exits;
    let exitSource = "env";
    if (recipeId) {
      try {
        const recipe = loadRecipeById(recipeId);
        if (recipe && recipe.compiled && recipe.compiled.exits) {
          exits = recipe.compiled.exits;
          exitSource = "recipe";
        }
      } catch (e: any) {
        logger.warn("POSITIONS", "PositionManager", "Failed to load recipe exits", {
          recipeId,
          error: e.message,
        });
      }
    }

    if (!this.exitSourceLog.has(mint)) {
      this.exitSourceLog.add(mint);
      logger.info("POSITIONS", "PositionManager", "Exit value source", {
        symbol,
        source: exitSource,
        strategyId: recipeId,
      });
    }

    // Determine exit clock: recipe clock_sec > per-source override > global
    const globalClockSec = getExitClockSec();
    let source = position.added_by_agent;
    // Position row may not carry added_by_agent; look it up from watchlist
    if (!source) {
      source = watchlistService.getAddedByAgent(mint);
    }
    let exitClockSec = globalClockSec;
    if (source === "mig_edge") {
      const migOverride = getClockSecMigEdge();
      if (migOverride !== null) exitClockSec = migOverride;
    }
    if (exits && exits.clock_sec !== undefined) {
      exitClockSec = exits.clock_sec;
    }

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
        await this.exitPosition(mint, symbol, `STALE_POSITION (${ageMinutes.toFixed(0)} min) | MFE n/a MAE n/a hv=na regime=na`, 0, 0);
      }
      return;
    }

    // Update peak price and last-high timestamp
    if (!this.positionPeaks.has(mint) || currentPrice > this.positionPeaks.get(mint)) {
      this.positionPeaks.set(mint, currentPrice);
      this.positionLastHighMs.set(mint, Date.now());
      await watchlistService.updatePeakPrice(mint, currentPrice);
      logger.debug("POSITIONS", "PositionManager", "Peak price updated", {
        symbol,
        peakPrice: currentPrice,
      });
    }

    // Seed and update trough (lowest price seen this process)
    if (!this.positionTroughs.has(mint) || currentPrice < this.positionTroughs.get(mint)) {
      this.positionTroughs.set(mint, currentPrice);
      logger.debug("POSITIONS", "PositionManager", "Trough price updated", {
        symbol,
        troughPrice: currentPrice,
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
    // Recipe exits loaded earlier; use them where set, env as fallback.
    const envTpPct = configService.getNumber("TAKE_PROFIT_PCT");
    const takeProfitPct = exits && exits.tp_pct !== undefined ? exits.tp_pct : envTpPct;
    const envTrailPct = configService.getNumber("TRAILING_STOP_PCT");
    const trailingStopPct = exits && exits.trail_pct !== undefined ? exits.trail_pct : envTrailPct;

    // Volatility-based stop: compute HV and derive stop distance
    // Recipe's stop_pct overrides HV stop when set; recipe pool_drop_pct overrides env
    const hv = await priceActionService.get24hHV(mint);
    const atrK = configService.getNumber("EXIT_ATR_K");
    let stopPct: number;
    let regime: "CHOP" | "TREND" | "SHOCK" | null = null;
    const envStopPct = configService.getNumber("STOP_LOSS_PCT");

    if (exits && exits.stop_pct !== undefined) {
      stopPct = exits.stop_pct;
      regime = null;
      logger.info("POSITIONS", "PositionManager", "Using recipe stop", {
        symbol,
        stopPct,
      });
    } else if (hv !== null) {
      stopPct = volStopPct(hv, atrK);
      regime = priceActionService.labelRegime(hv);
      logger.info("POSITIONS", "PositionManager", "Volatility stop computed", {
        symbol,
        hv: hv.toFixed(4),
        atrK,
        stopPct: stopPct.toFixed(1),
        regime,
      });
    } else {
      stopPct = envStopPct;
      logger.info("POSITIONS", "PositionManager", "HV unavailable, using legacy stop", {
        symbol,
        stopPct,
      });
    }

    const entryForExcursion = position.entry_price_usd || currentPrice;
    const peakForExcursion = this.positionPeaks.get(mint) || currentPrice;
    const troughForExcursion = this.positionTroughs.get(mint) || currentPrice;
    const exc = excursionSnippet(entryForExcursion, peakForExcursion, troughForExcursion, hv, regime);

    // Phase 14A: trailing stop only arms after peak reaches take-profit threshold
    const peakPnlPct = ((peakForExcursion - entryForExcursion) / entryForExcursion) * 100;

    // Phase 23A: Pool drop exit (fast-rug signal) — check before stop-loss
    // Recipe pool_drop_pct overrides env
    const envPoolDropPct = getPoolDropPct();
    const poolDropPct = exits && exits.pool_drop_pct !== undefined ? exits.pool_drop_pct : envPoolDropPct;
    if (poolDropPct > 0) {
      let initialQuote = this.positionPoolQuotes.get(mint);
      if (initialQuote === undefined) {
        initialQuote = await this.getPoolQuote(mint);
        if (initialQuote !== null) {
          this.positionPoolQuotes.set(mint, initialQuote);
        }
      }
      if (initialQuote !== null) {
        const currentQuote = await this.getPoolQuote(mint);
        if (currentQuote !== null) {
          const quoteChange = ((initialQuote - currentQuote) / initialQuote) * 100;
          if (quoteChange >= poolDropPct) {
            logger.info("POSITIONS", "PositionManager", "POOL_DROP triggered", {
              symbol,
              quoteChangePct: quoteChange.toFixed(1),
              initialQuote: initialQuote.toFixed(2),
              currentQuote: currentQuote.toFixed(2),
            });
            await this.exitPosition(mint, symbol, `POOL_DROP (${quoteChange.toFixed(1)}% drop) | ${exc}`, currentPrice, pnlPct);
            return;
          }
        }
      }
    }

    if (pnlPct >= takeProfitPct) {
      logger.info("POSITIONS", "PositionManager", "TAKE_PROFIT triggered", {
        symbol,
        pnlPct: pnlPct.toFixed(1),
        takeProfitPct,
      });
      await this.exitPosition(mint, symbol, `TAKE_PROFIT (+${pnlPct.toFixed(1)}%) | ${exc}`, currentPrice, pnlPct);
    } else {
      // Phase 23D: stall exit — no new high for stallSec seconds
      const stallSec = getStallSec();
      if (stallSec > 0) {
        const lastHighMs = this.positionLastHighMs.get(mint) || Date.now();
        const gapSec = (Date.now() - lastHighMs) / 1000;
        if (gapSec >= stallSec) {
          logger.info("POSITIONS", "PositionManager", "STALL triggered", {
            symbol,
            gapSec: Math.floor(gapSec),
            stallSec,
          });
          await this.exitPosition(mint, symbol, `STALL (${Math.floor(gapSec)}s no new high) | ${exc}`, currentPrice, pnlPct);
          return;
        }
      }
      if (pnlPct <= -stopPct) {
        logger.info("POSITIONS", "PositionManager", "STOP_LOSS triggered", {
          symbol,
          pnlPct: pnlPct.toFixed(1),
          stopPct,
        });
        await this.exitPosition(mint, symbol, `STOP_LOSS (${pnlPct.toFixed(1)}%) | ${exc}`, currentPrice, pnlPct);
      } else if (peakPnlPct >= takeProfitPct && trailingStopDistance >= trailingStopPct && peakPrice > entryPrice) {
        logger.info("POSITIONS", "PositionManager", "TRAILING_STOP triggered", {
          symbol,
          trailingStopDistance: trailingStopDistance.toFixed(1),
          trailingStopPct,
          peakPnlPct: peakPnlPct.toFixed(1),
        });
        await this.exitPosition(
          mint,
          symbol,
          `TRAILING_STOP (${trailingStopDistance.toFixed(1)}% below peak) | ${exc}`,
          currentPrice,
          pnlPct
        );
      } else if (exitClockSec > 0 && ageSeconds >= exitClockSec) {
        logger.info("POSITIONS", "PositionManager", "CLOCK triggered", {
          symbol,
          ageSeconds: Math.floor(ageSeconds),
          exitClockSec,
        });
        await this.exitPosition(mint, symbol, `CLOCK (${Math.floor(ageSeconds)} sec) | ${exc}`, currentPrice, pnlPct);
      } else if (ageMinutes > staleMinutes && pnlPct < 10) {
        logger.info("POSITIONS", "PositionManager", "STALE_POSITION triggered", {
          symbol,
          ageMinutes: ageMinutes.toFixed(0),
          staleMinutes,
        });
        await this.exitPosition(mint, symbol, `STALE_POSITION (${ageMinutes.toFixed(0)} min) | ${exc}`, currentPrice, pnlPct);
      } else {
        logger.debug("POSITIONS", "PositionManager", "Position held", {
          symbol,
          pnlPct: pnlPct.toFixed(1),
          ageMinutes: ageMinutes.toFixed(0),
          peakPrice: peakPrice.toFixed(6),
        });
      }
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
      // Calculate realized PnL in SOL (entryPrice is SOL per token)
      const pos = await watchlistService.getOpenPositions().then(ps => ps.find(p => p.mint_address === mint));
      const amountSol = pos ? pos.amount_sol : 0;
      const entryPrice = pos ? (pos.entry_price_usd || exitPrice) : exitPrice;
      const realizedPnl = amountSol * (exitPrice - entryPrice);

      // Phase 2A: feed session realized PnL into risk circuit breaker
      // Phase 10A: dry-run PnL and status handled inside executeSell, skip here
      if (!result.dryRun) {
        addSessionPnl(realizedPnl);
        await watchlistService.updatePositionStatus(
          mint,
          "CLOSED",
          exitPrice,
          realizedPnl,
          result.txSignature
        );
      }

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
      this.positionTroughs.delete(mint);
      this.positionPoolQuotes.delete(mint);
      this.positionLastHighMs.delete(mint);
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

  private async getPoolQuote(mint: string): Promise<number | null> {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (!response.ok) return null;
      const data = await response.json();
      const pairs = data?.pairs;
      if (!Array.isArray(pairs)) return null;
      const pumpPair = pairs.find((p: any) => p.dexId === "pumpswap");
      if (!pumpPair) return null;
      const quote = pumpPair.liquidity?.quote;
      if (quote === undefined || quote === null) return null;
      return parseFloat(quote);
    } catch (e) {
      logger.debug("POSITIONS", "PositionManager", "Error fetching pool quote", {
        mint,
        error: e.message,
      });
      return null;
    }
  }
}

export const positionManagerService = new PositionManagerService(null);
export default positionManagerService;