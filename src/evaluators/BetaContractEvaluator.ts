import { watchlistService } from "../services/WatchlistService.ts";
import { contractForensicsService } from "../services/ContractForensicsService.ts";
import { postWarRoomMessage } from "../services/WarRoomService.ts";

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
    if (tokensNeedingEval.length === 0) return;

    for (const token of tokensNeedingEval) {
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

        // War room: broadcast risk assessment
        await postWarRoomMessage("BETA", "RISK_ASSESSMENT", {
          symbol: token.symbol,
          decision: verdict.decision === "PASS" ? "BUY" : "SELL",
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
