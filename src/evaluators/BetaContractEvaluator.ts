import { watchlistService } from "../services/WatchlistService.ts";
import { contractForensicsService } from "../services/ContractForensicsService.ts";

export async function evaluateBetaContract(runtime) {
  try {
    runtime.logger.info("[Beta] Contract forensics evaluator running");

    // Get pending evaluation requests from war room
    // In production: subscribe to NARRATIVE_EVALUATION_PASS and TOP_TRADER_BUY_DETECTED events

    // For now, scan watchlist for tokens that need contract evaluation
    const tokens = await watchlistService.getWatchedTokens();
    const tokensNeedingEval = tokens.filter((t) => t.narrative_score > 0 && t.narrative_score < 0.75);

    if (tokensNeedingEval.length === 0) {
      runtime.logger.info("[Beta] No tokens requiring contract evaluation");
      return;
    }

    for (const token of tokensNeedingEval) {
      try {
        runtime.logger.info(`[Beta] Analyzing contract for ${token.symbol} (${token.mint_address})`);

        const report = await contractForensicsService.analyzeToken(token.mint_address);

        runtime.logger.info(`[Beta] ${token.symbol} contract analysis: ${report.status}`);
        if (report.reasons.length > 0) {
          runtime.logger.info(`[Beta] Reasons: ${report.reasons.join("; ")}`);
        }

        if (report.status === "PASS") {
          // Contract is safe - update watchlist
          await watchlistService.updateTokenScore(token.mint_address, 1.0);

          const signal = {
            event: "CONTRACT_SAFETY_PASS",
            mint_address: token.mint_address,
            symbol: token.symbol,
            liquidity_usd: null, // Would come from RugCheck
            top10_concentration_pct: report.top10ConcentrationPct,
            reasoning: `Mint/freeze revoked, ${report.rugcheckScore} RugCheck score, top 10 holders own ${report.top10ConcentrationPct}%.`
          };

          const channel = runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Beta" },
              text: JSON.stringify(signal),
              timestamp: Date.now()
            });
          }

          runtime.emitEvent("beta_contract_pass", signal);
        } else {
          // Contract has risks - mark as high risk
          runtime.logger.info(`[Beta] ${token.symbol} FAILED contract evaluation`);

          const signal = {
            event: "CONTRACT_SAFETY_FAIL",
            mint_address: token.mint_address,
            symbol: token.symbol,
            reasons: report.reasons,
            rugcheck_score: report.rugcheckScore
          };

          const channel = runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Beta" },
              text: JSON.stringify(signal),
              timestamp: Date.now()
            });
          }

          // Remove from watchlist if high risk
          if (report.rugcheckScore > 15) {
            runtime.logger.info(`[Beta] Pruning ${token.symbol} due to high risk (score ${report.rugcheckScore})`);
            await watchlistService.removeToken(token.mint_address);
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