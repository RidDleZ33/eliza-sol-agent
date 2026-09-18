import { watchlistService } from "../services/WatchlistService.ts";
import { contractForensicsService } from "../services/ContractForensicsService.ts";
import { WAR_ROOM_ID } from "../utils/warRoom.ts";

export async function evaluateBetaContract(runtime) {
  try {
    runtime.logger.info("[Beta] Contract forensics evaluator running");

    // Get tokens passed by Alpha that need contract evaluation
    // Only evaluate tokens that Alpha has passed (ALPHA_PASSED status)
    const tokensNeedingEval = await watchlistService.getTokensForBetaEvaluation();

    if (tokensNeedingEval.length === 0) {
      runtime.logger.info("[Beta] No tokens passed by Alpha requiring contract evaluation");
      return;
    }

    runtime.logger.info(`[Beta] Found ${tokensNeedingEval.length} tokens passed by Alpha for contract evaluation`);
    for (const token of tokensNeedingEval) {
      runtime.logger.info(`[Beta]   - ${token.symbol} (narrative_score: ${token.narrative_score})`);
    }

    for (const token of tokensNeedingEval) {
      try {
        runtime.logger.info(`[Beta] Analyzing contract for ${token.symbol} (${token.mint_address})`);

        let report;
        try {
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Contract analysis timeout after 90s')), 90000)
          );
          report = await Promise.race([
            contractForensicsService.analyzeToken(token.mint_address),
            timeout
          ]);
        } catch (e) {
          runtime.logger.error(`[Beta] Error calling contractForensicsService.analyzeToken for ${token.symbol}:`, e);
          // On error/timeout, mark as BETA_FAILED so token doesn't remain stuck
          await watchlistService.updateTokenStatus(token.mint_address, "BETA_FAILED", 0.0, "ANALYSIS_ERROR");
          runtime.logger.info(`[Beta] ${token.symbol} marked as BETA_FAILED due to analysis error`);
          continue; // Skip to next token
        }

        runtime.logger.info(`[Beta] ${token.symbol} contract analysis: ${report.status}`);
        if (report.reasons.length > 0) {
          runtime.logger.info(`[Beta] Reasons: ${report.reasons.join("; ")}`);
        }

        if (report.status === "PASS") {
          // Contract is safe - update watchlist to BETA_PASSED
          await watchlistService.updateTokenStatus(token.mint_address, "BETA_PASSED", 1.0);
          runtime.logger.info(`[Beta] ${token.symbol} PASSED contract evaluation`);

          const signal = {
            event: "CONTRACT_SAFETY_PASS",
            mint_address: token.mint_address,
            symbol: token.symbol,
            liquidity_usd: null, // Would come from RugCheck
            top10_concentration_pct: report.top10ConcentrationPct,
            reasoning: `Mint/freeze revoked, ${report.rugcheckScore} RugCheck score, top 10 holders own ${report.top10ConcentrationPct}%.`
          };

          try {
            const channel = runtime.getRoom(WAR_ROOM_ID);
            if (channel && typeof channel.publish === "function") {
              channel.publish({
                author: { name: "Beta" },
                text: JSON.stringify(signal),
                timestamp: Date.now()
              });
            }
          } catch (e) {
            // Non-fatal: primary signal is the SQLite status update and event emitter
            runtime.logger.warn(`[Beta] Room publish skipped for ${token.symbol}:`, e.message);
          }

          runtime.emitEvent("beta_contract_pass", signal);
        } else {
          // Contract has risks - mark as BETA_FAILED with score 0.0
          runtime.logger.info(`[Beta] ${token.symbol} FAILED contract evaluation`);
          await watchlistService.updateTokenStatus(token.mint_address, "BETA_FAILED", 0.0, "CONTRACT_RISK");

          const signal = {
            event: "CONTRACT_SAFETY_FAIL",
            mint_address: token.mint_address,
            symbol: token.symbol,
            reasons: report.reasons,
            rugcheck_score: report.rugcheckScore
          };

          try {
            const channel = runtime.getRoom(WAR_ROOM_ID);
            if (channel && typeof channel.publish === "function") {
              channel.publish({
                author: { name: "Beta" },
                text: JSON.stringify(signal),
                timestamp: Date.now()
              });
            }
          } catch (e) {
            runtime.logger.warn(`[Beta] Room publish skipped for ${token.symbol}:`, e.message);
          }

          runtime.emitEvent("beta_contract_fail", signal);
        }
      } catch (e) {
        runtime.logger.error(`[Beta] Error analyzing ${token.symbol}:`, e);
      }
    }
  } catch (e) {
    runtime.logger.error("[Beta] Error in contract evaluation loop:", e);
  }
}