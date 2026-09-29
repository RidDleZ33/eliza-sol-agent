import { watchlistService } from "../services/WatchlistService.ts";
import { tradeExecutionService } from "../services/TradeExecutionService.ts";
import { WAR_ROOM_ID } from "../utils/warRoom.ts";
import { postWarRoomMessage } from "../services/WarRoomService.ts";
import { priceActionService } from "../services/PriceActionService.ts";
import { PAMetrics } from "../types/priceAction.ts";

// Gamma evaluator: entry decisions only. Exit management is the sole responsibility
// of PositionManagerService (stop/TP/trailing logic runs on its own interval).
export async function evaluateGammaConsensus(runtime: any) {
  try {
    // Candidate Pipeline Evaluation (Potential Buy Check)
    runtime.logger.info("[Gamma] Evaluating new candidate pipeline...");
    await evaluateCandidatePipeline(runtime);
  } catch (e: any) {
    runtime.logger.error("[Gamma] Error in consensus loop:", e);
  }
}

/**
 * Candidate Pipeline Evaluation & Buy Execution
 */
async function evaluateCandidatePipeline(runtime: any) {
  const candidates = await watchlistService.getTokensForGammaConsensus();
  runtime.logger.info(`[GAMMA] GammaConsensusEvaluator: queue candidates=${candidates.length}`);

  for (const candidate of candidates) {
    try {
      // 1. Immediately lock candidate in DB so loop tick won't re-evaluate it concurrently
      await watchlistService.updateTokenStatus(candidate.mint_address, "GAMMA_EVALUATING");

      // 2. Guard: Check if position is already open or already traded
      if (await watchlistService.hasPosition(candidate.mint_address)) {
        await watchlistService.updateTokenStatus(candidate.mint_address, "TRADED");
        continue;
      }

      // Fetch price action metrics for entry timing analysis
      let paMetrics: PAMetrics | null = null;
      try {
        paMetrics = await priceActionService.getPAMetrics(candidate.mint_address);
        if (paMetrics) {
          runtime.logger.info(`[Gamma] ${candidate.symbol} PA Metrics:`, {
            vwapRatio: paMetrics.vwapRatio.toFixed(3),
            buySellRatio: paMetrics.buySellRatio5m.toFixed(2),
            distanceFromPeak: paMetrics.distanceFromPeakPct.toFixed(1) + '%',
            emaTrend: paMetrics.emaTrend,
            isOverextended: paMetrics.isOverextended
          });
        }
      } catch (e) {
        runtime.logger.warn(`[Gamma] Failed to fetch PA metrics for ${candidate.symbol}:`, e.message);
      }

      // Phase 11A: fetch 24h HV for snapshot + regime commentary
      let hv: number | null = null;
      let regime: string | null = null;
      try {
        hv = await priceActionService.get24hHV(candidate.mint_address);
        if (hv !== null) {
          regime = priceActionService.labelRegime(hv);
        }
      } catch (e) {
        runtime.logger.warn(`[Gamma] Failed to fetch 24h HV for ${candidate.symbol}:`, e.message);
      }

      const synthesis = synthesizeCommitteeSignals(candidate, paMetrics);
      runtime.logger.info(`[Gamma] ${candidate.symbol} Conviction: ${synthesis.convictionScore.toFixed(2)} -> Decision: ${synthesis.decision}`);

      // Phase 11A: save gamma snapshot on every synthesis (BUY, DEFER, PRUNE)
      const paForSnapshot = paMetrics ? {
        vwapRatio: paMetrics.vwapRatio,
        buySellRatio5m: paMetrics.buySellRatio5m,
        distanceFromPeakPct: paMetrics.distanceFromPeakPct,
        emaTrend: paMetrics.emaTrend,
        isOverextended: paMetrics.isOverextended,
        currentPriceUsd: paMetrics.currentPriceUsd,
      } : null;
      await watchlistService.saveGammaSnapshot(
        candidate.mint_address,
        synthesis.decision,
        synthesis.convictionScore,
        synthesis.reasons,
        paForSnapshot,
        hv,
        regime
      );

      // War room: broadcast consensus decision
      await postWarRoomMessage("GAMMA", "CONSENSUS_REACHED", {
        symbol: candidate.symbol,
        decision: synthesis.decision,
        confidence: synthesis.convictionScore,
        reasons: synthesis.reasons
      });

      if (synthesis.decision === "BUY") {
        await watchlistService.logTradeJournal({
          mint_address: candidate.mint_address,
          symbol: candidate.symbol,
          event_type: "BUY_INTENT",
          conviction_score: synthesis.convictionScore,
          reason: synthesis.reasons.join("; "),
        });

        // size from risk caps, not Alpha text
        const buyResult = await tradeExecutionService.executeBuy(
          candidate.mint_address,
          candidate.symbol,
          synthesis.convictionScore,
          "Committee Consensus",
          synthesis.reasons.join("; ")
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

function synthesizeCommitteeSignals(candidate: any, paMetrics?: PAMetrics | null) {
  const reasons: string[] = [];

  // Existing hard vetoes
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

  // NEW: Price Action hard vetoes
  if (paMetrics) {
    // HARD VETO: Heavy sell pressure (buy/sell ratio < 0.5)
    if (paMetrics.buySellRatio5m < 0.5) {
      return {
        decision: "PRUNE",
        convictionScore: 0,
        reasons: [`HARD VETO (PA): Buy/Sell ratio 5m is ${paMetrics.buySellRatio5m.toFixed(2)} (heavy sell pressure)`]
      };
    }

    // HARD VETO: Bearish EMA trend
    if (paMetrics.emaTrend === 'BEARISH') {
      return {
        decision: "PRUNE",
        convictionScore: 0,
        reasons: [`HARD VETO (PA): Bearish EMA trend (9<21)`]
      };
    }

    // DEFER: Price overextended (buying the top)
    if (paMetrics.isOverextended) {
      return {
        decision: "DEFER",
        convictionScore: 0,
        reasons: [
          `DEFER (PA): Price overextended. VWAP ratio: ${paMetrics.vwapRatio.toFixed(2)}, ` +
          `Distance from peak: ${paMetrics.distanceFromPeakPct.toFixed(1)}%`
        ]
      };
    }

    // Log PA context for transparency
    reasons.push(`PA: VWAP ratio ${paMetrics.vwapRatio.toFixed(2)}, B/S ${paMetrics.buySellRatio5m.toFixed(2)}, Peak drop ${paMetrics.distanceFromPeakPct.toFixed(1)}%`);
  }

  const convictionScore = 0.45 * (alphaScore * alphaConf) + 0.55 * (betaScore * betaConf);

  reasons.push(`Alpha: ${alphaScore.toFixed(2)} (Conf: ${alphaConf.toFixed(2)})`);
  reasons.push(`Beta: ${betaScore.toFixed(2)} (Conf: ${betaConf.toFixed(2)})`);

  // Apply PA boost: ideal entry zone (12-28% pullback from peak with good momentum)
  let finalScore = convictionScore;
  if (paMetrics && paMetrics.distanceFromPeakPct >= -28 && paMetrics.distanceFromPeakPct <= -12
      && paMetrics.buySellRatio5m > 1.3 && paMetrics.vwapRatio >= 0.95 && paMetrics.vwapRatio <= 1.10) {
    finalScore = Math.min(0.95, finalScore + 0.10);
    reasons.push("BUY BOOST (PA): Ideal dip entry zone (+0.10 conviction)");
  }

  if (finalScore >= 0.72) return { decision: "BUY", convictionScore: finalScore, reasons };
  if (finalScore >= 0.48) return { decision: "DEFER", convictionScore: finalScore, reasons };
  return { decision: "PRUNE", convictionScore: finalScore, reasons };
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
