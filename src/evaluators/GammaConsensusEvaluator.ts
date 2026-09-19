import { watchlistService } from "../services/WatchlistService.ts";
import { tradeExecutionService } from "../services/TradeExecutionService.ts";
import { WAR_ROOM_ID } from "../utils/warRoom.ts";

export async function evaluateGammaConsensus(runtime: any) {
  try {
    // PHASE 1: Active Trade Checkup (Position Management)
    runtime.logger.info("[Gamma Phase 1] Checking health of active open positions...");
    await manageActivePositions(runtime);

    // PHASE 2: Candidate Pipeline Evaluation (Potential Buy Check)
    runtime.logger.info("[Gamma Phase 2] Evaluating new candidate pipeline...");
    await evaluateCandidatePipeline(runtime);

  } catch (e: any) {
    runtime.logger.error("[Gamma] Error in consensus loop:", e);
  }
}

/**
 * PHASE 1: Active Trade Checkup & Stop/Profit Management
 */
async function manageActivePositions(runtime: any) {
  const openPositions = await watchlistService.getOpenPositions();
  if (openPositions.length === 0) return;

  const priceService = runtime.getService("PRICE_SERVICE");

  for (const pos of openPositions) {
    try {
      const currentPrice = priceService ? await priceService.getPrice(pos.mint_address) : pos.entry_price_usd;
      if (!currentPrice || currentPrice === 0) continue;

      const entryPrice = pos.entry_price_usd || currentPrice;
      const peakPrice = Math.max(pos.peak_price_usd || entryPrice, currentPrice);

      if (peakPrice > (pos.peak_price_usd || 0)) {
        await watchlistService.updatePeakPrice(pos.mint_address, peakPrice);
        await watchlistService.logTradeJournal({
          position_id: pos.id,
          mint_address: pos.mint_address,
          symbol: pos.symbol,
          event_type: "STOP_LOSS_UPDATED",
          price_usd: peakPrice,
          reason: `New peak high reached: $${peakPrice.toFixed(6)}`,
        });
      }

      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;

      let shouldSell = false;
      let sellReason = "";

      if (pnlPct <= -12) {
        shouldSell = true;
        sellReason = `HARD_STOP_LOSS: PnL dropped to ${pnlPct.toFixed(2)}%`;
      } else if (pnlPct >= 100 && dropFromPeakPct >= 10) {
        shouldSell = true;
        sellReason = `TRAILING_STOP_TIER_3: Peak $${peakPrice.toFixed(4)}, dropped ${dropFromPeakPct.toFixed(2)}%`;
      } else if (pnlPct >= 50 && dropFromPeakPct >= 15) {
        shouldSell = true;
        sellReason = `TRAILING_STOP_TIER_2: Peak $${peakPrice.toFixed(4)}, dropped ${dropFromPeakPct.toFixed(2)}%`;
      } else if (pnlPct >= 25 && pnlPct < 50 && currentPrice <= entryPrice * 1.02) {
        shouldSell = true;
        sellReason = `BREAKEVEN_STOP: Retraced to entry +2% after +25% move`;
      }

      if (shouldSell) {
        runtime.logger.info(`[Gamma] Executing sell for ${pos.symbol}: ${sellReason}`);
        const sellResult = await tradeExecutionService.executeSell(pos.mint_address, pos.symbol, sellReason);

        if (sellResult.success) {
          const realizedPnl = (currentPrice - entryPrice) * pos.amount_sol;
          await watchlistService.updatePositionStatus(pos.mint_address, "CLOSED", currentPrice, realizedPnl, sellResult.txSignature);
          await watchlistService.updateTokenStatus(pos.mint_address, "POSITION_CLOSED");

          await watchlistService.logTradeJournal({
            position_id: pos.id,
            mint_address: pos.mint_address,
            symbol: pos.symbol,
            event_type: "SELL_EXECUTED",
            price_usd: currentPrice,
            reason: sellReason,
            tx_signature: sellResult.txSignature,
          });

          await publishSignal(runtime, "POSITION_CLOSED", {
            mint_address: pos.mint_address,
            symbol: pos.symbol,
            pnlPct: pnlPct.toFixed(2),
            reason: sellReason,
            txSignature: sellResult.txSignature,
          });
        }
      }
    } catch (e: any) {
      runtime.logger.error(`[Gamma] Error managing open position ${pos.symbol}:`, e);
    }
  }
}

/**
 * PHASE 2: Candidate Pipeline Evaluation & Buy Execution
 */
async function evaluateCandidatePipeline(runtime: any) {
  const candidates = await watchlistService.getTokensForGammaConsensus();

  for (const candidate of candidates) {
    try {
      // 1. Immediately lock candidate in DB so loop tick won't re-evaluate it concurrently
      await watchlistService.updateTokenStatus(candidate.mint_address, "GAMMA_EVALUATING");

      // 2. Guard: Check if position is already open or already traded
      if (await watchlistService.hasPosition(candidate.mint_address)) {
        await watchlistService.updateTokenStatus(candidate.mint_address, "TRADED");
        continue;
      }

      const synthesis = synthesizeCommitteeSignals(candidate);
      runtime.logger.info(`[Gamma] ${candidate.symbol} Conviction: ${synthesis.convictionScore.toFixed(2)} -> Decision: ${synthesis.decision}`);

      if (synthesis.decision === "BUY") {
        await watchlistService.logTradeJournal({
          mint_address: candidate.mint_address,
          symbol: candidate.symbol,
          event_type: "BUY_INTENT",
          conviction_score: synthesis.convictionScore,
          reason: synthesis.reasons.join("; "),
        });

        const buyResult = await tradeExecutionService.executeBuy(
          candidate.mint_address,
          candidate.symbol,
          synthesis.convictionScore,
          "Committee Consensus"
        );

        if (buyResult.success) {
          await watchlistService.updateTokenStatus(candidate.mint_address, "TRADED");
          await watchlistService.logTradeJournal({
            mint_address: candidate.mint_address,
            symbol: candidate.symbol,
            event_type: "BUY_EXECUTED",
            conviction_score: synthesis.convictionScore,
            tx_signature: buyResult.txSignature,
            reason: "Trade executed successfully",
          });
          await publishSignal(runtime, "TRADE_EXECUTED", {
            mint_address: candidate.mint_address,
            symbol: candidate.symbol,
            txSignature: buyResult.txSignature,
            convictionScore: synthesis.convictionScore,
          });
        } else {
          await watchlistService.updateTokenStatus(candidate.mint_address, "BUY_FAILED", 0, buyResult.error);
          await watchlistService.logTradeJournal({
            mint_address: candidate.mint_address,
            symbol: candidate.symbol,
            event_type: "BUY_FAILED",
            reason: buyResult.error,
          });
        }
      } else if (synthesis.decision === "DEFER") {
        await watchlistService.deferToken(candidate.mint_address, 10);
      } else if (synthesis.decision === "PRUNE") {
        await watchlistService.updateTokenStatus(candidate.mint_address, "GAMMA_REJECTED", 0, synthesis.reasons.join("; "));
        await watchlistService.logTradeJournal({
          mint_address: candidate.mint_address,
          symbol: candidate.symbol,
          event_type: "PRUNED",
          reason: synthesis.reasons.join("; "),
        });
      }
    } catch (e: any) {
      runtime.logger.error(`[Gamma] Error evaluating pipeline token ${candidate.symbol}:`, e);
      await watchlistService.updateTokenStatus(candidate.mint_address, "GAMMA_ERROR", 0, e.message);
    }
  }
}

function synthesizeCommitteeSignals(candidate: any) {
  const reasons: string[] = [];

  if (candidate.beta_mint_disabled === 0) {
    return { decision: "PRUNE", convictionScore: 0, reasons: ["HARD VETO: Mint authority active"] };
  }
  if (candidate.beta_freeze_disabled === 0) {
    return { decision: "PRUNE", convictionScore: 0, reasons: ["HARD VETO: Freeze authority active"] };
  }

  const alphaScore = candidate.alpha_narrative_score ?? candidate.narrative_score ?? 0.5;
  const alphaConf = candidate.alpha_confidence ?? 0.5;
  const alphaOrganicity = candidate.alpha_organicity_score ?? 0.5;

  const betaScore = candidate.beta_security_score ?? 0.5;
  const betaConf = candidate.beta_confidence ?? 0.5;

  if (alphaOrganicity < 0.35) {
    return { decision: "PRUNE", convictionScore: 0, reasons: [`HARD VETO: Artificial/Bot volume (Organicity: ${alphaOrganicity})`] };
  }

  const convictionScore = 0.45 * (alphaScore * alphaConf) + 0.55 * (betaScore * betaConf);

  reasons.push(`Alpha: ${alphaScore.toFixed(2)} (Conf: ${alphaConf.toFixed(2)})`);
  reasons.push(`Beta: ${betaScore.toFixed(2)} (Conf: ${betaConf.toFixed(2)})`);

  if (convictionScore >= 0.72) return { decision: "BUY", convictionScore, reasons };
  if (convictionScore >= 0.48) return { decision: "DEFER", convictionScore, reasons };
  return { decision: "PRUNE", convictionScore, reasons };
}

async function publishSignal(runtime: any, event: string, payload: any) {
  try {
    const channel = runtime.getRoom(WAR_ROOM_ID);
    if (channel && typeof channel.publish === "function") {
      channel.publish({
        author: { name: "Gamma" },
        text: JSON.stringify({ event, ...payload }),
        timestamp: Date.now(),
      });
    }
  } catch (e: any) {
    runtime.logger.warn(`[Gamma] Signal publish failed:`, e.message);
  }
}
