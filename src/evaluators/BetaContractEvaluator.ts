import { watchlistService } from "../services/WatchlistService.ts";
import { contractForensicsService } from "../services/ContractForensicsService.ts";
import { postWarRoomMessage } from "../services/WarRoomService.ts";
import { getMinLiquidityUsd, getDexscreenerProfilesMaxAgeH } from "../utils/env.ts";

export type DecisionType = "PASS" | "FAIL" | "DISSENT";

export interface BetaVerdict {
  decision: DecisionType;
  confidenceRatio: number;
  securityScore: number;
  isMintDisabled: boolean;
  isFreezeDisabled: boolean;
  top10ConcentrationPct: number;
  reasons: string[];
}

export async function evaluateBetaContract(runtime: any) {
  try {
    const tokensNeedingEval = await watchlistService.getTokensForBetaEvaluation();
    runtime.logger.info(`[BETA] BetaContractEvaluator: queue ALPHA_PASSED=${tokensNeedingEval.length}`);
    if (tokensNeedingEval.length === 0) return;

    // Phase 9C: batch limit — process at most 5 tokens per tick, leave rest for next interval
    const batch = tokensNeedingEval.slice(0, 5);
    const remaining = tokensNeedingEval.length - 5;
    if (batch.length > 0 && remaining > 0) {
      runtime.logger.info(`[BETA] batch n=${batch.length} remaining=${remaining}`);
    }

    for (const token of batch) {
      try {
        const report = await contractForensicsService.analyzeToken(token.mint_address);

        let verdict: BetaVerdict;

        if (report.status === "PASS") {
          verdict = {
            decision: "PASS",
            confidenceRatio: 0.95,
            securityScore: Math.max(0, 1 - report.rugcheckScore / 2000),
            isMintDisabled: report.isMintDisabled,
            isFreezeDisabled: report.isFreezeDisabled,
            top10ConcentrationPct: report.top10ConcentrationPct,
            reasons: ["Contract safe: Mint & freeze revoked, LP secured, low top 10 concentration."],
          };
        } else if (!report.isMintDisabled || !report.isFreezeDisabled) {
          verdict = {
            decision: "FAIL",
            confidenceRatio: 1.0,
            securityScore: 0.0,
            isMintDisabled: report.isMintDisabled,
            isFreezeDisabled: report.isFreezeDisabled,
            top10ConcentrationPct: report.top10ConcentrationPct,
            reasons: report.reasons,
          };
        } else {
          // Dissent check: If authorities are revoked but LP is unlocked or score is borderline
          verdict = {
            decision: "DISSENT",
            confidenceRatio: 0.60,
            securityScore: 0.40,
            isMintDisabled: report.isMintDisabled,
            isFreezeDisabled: report.isFreezeDisabled,
            top10ConcentrationPct: report.top10ConcentrationPct,
            reasons: report.reasons,
          };
        }

        runtime.logger.info(`[Beta] ${token.symbol} Verdict: ${verdict.decision} (${verdict.reasons.join("; ")})`);

        // Phase 12K+12L: refresh stale pair on re-eval, then apply MIN_LIQUIDITY_USD floor
        const minLiquidity = getMinLiquidityUsd();
        let dexPair = watchlistService.getDexPair(token.mint_address);

        // Phase 12L: refresh if missing or older than defer window (10 min)
        const staleMs = 10 * 60 * 1000;
        if (!dexPair || !dexPair.at || Date.now() - dexPair.at > staleMs) {
          runtime.logger.info(`[Beta] ${token.symbol} refreshing dex pair (stale or missing)`);
          try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${token.mint_address}`;
            const resp = await fetch(url);
            if (resp.ok) {
              const data = await resp.json();
              const pairs = data?.pairs;
              if (pairs && pairs.length > 0) {
                watchlistService.saveDexPair(token.mint_address, pairs[0]);
                dexPair = watchlistService.getDexPair(token.mint_address);
              }
            }
          } catch (e: any) {
            runtime.logger.error(`[Beta] ${token.symbol} dex pair refresh failed:`, e.message);
          }
        }

        if (!dexPair) {
          runtime.logger.info(`[Beta] ${token.symbol} liquidity FAIL: no stashed dex pair`);
          verdict = {
            decision: "FAIL",
            confidenceRatio: 1.0,
            securityScore: 0.0,
            isMintDisabled: false,
            isFreezeDisabled: false,
            top10ConcentrationPct: 0,
            reasons: ["liquidity unknown (no dex pair)"],
          };
        } else {
          // Phase 12L: guard liquidity.usd — missing field fails closed
          if (dexPair.pair.liquidity == null || dexPair.pair.liquidity.usd == null) {
            runtime.logger.info(`[Beta] ${token.symbol} liquidity FAIL: liquidity field missing`);
            verdict = {
              decision: "FAIL",
              confidenceRatio: 1.0,
              securityScore: 0.0,
              isMintDisabled: false,
              isFreezeDisabled: false,
              top10ConcentrationPct: 0,
              reasons: ["liquidity unknown (missing field)"],
            };
          } else if (dexPair.pair.liquidity.usd < minLiquidity) {
            // Phase 12L: age alone does not fail — only old+thin pools
            const maxAgeMs = getDexscreenerProfilesMaxAgeH() * 60 * 60 * 1000;
            let ageMs = 0;
            if (dexPair.pair.pairCreatedAt) {
              ageMs = Date.now() - dexPair.pair.pairCreatedAt;
            }
            const tooOld = ageMs > maxAgeMs;

            if (tooOld) {
              runtime.logger.info(`[Beta] ${token.symbol} liquidity FAIL: old+thin pool (${dexPair.pair.liquidity.usd} < ${minLiquidity}, age > ${getDexscreenerProfilesMaxAgeH()}h)`);
            } else {
              runtime.logger.info(`[Beta] ${token.symbol} liquidity FAIL: ${dexPair.pair.liquidity.usd} < ${minLiquidity}`);
            }
            verdict = {
              decision: "FAIL",
              confidenceRatio: 1.0,
              securityScore: 0.0,
              isMintDisabled: false,
              isFreezeDisabled: false,
              top10ConcentrationPct: 0,
              reasons: [`liquidity ${dexPair.pair.liquidity.usd} < ${minLiquidity}${tooOld ? " (old thin pool)" : ""}`],
            };
          }
        }

        // War room: broadcast risk assessment
        await postWarRoomMessage("BETA", "RISK_ASSESSMENT", {
          symbol: token.symbol,
          decision: verdict.decision,
          confidence: verdict.confidenceRatio,
          reasoning: verdict.reasons.join("; ")
        });

        await watchlistService.updateTokenBetaVerdict(token.mint_address, verdict);

        runtime.emitEvent("beta_evaluation_complete", {
          mint_address: token.mint_address,
          symbol: token.symbol,
          verdict,
        });
      } catch (e: any) {
        runtime.logger.error(`[Beta] Error evaluating ${token.symbol}:`, e);
      }
    }
  } catch (e: any) {
    runtime.logger.error("[Beta] Error in contract evaluation loop:", e);
  }
}
