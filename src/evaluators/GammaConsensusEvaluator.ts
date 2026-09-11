import { watchlistService } from "../services/WatchlistService.ts";
import { tradeExecutionService } from "../services/TradeExecutionService.ts";

export async function evaluateGammaConsensus(runtime) {
  try {
    runtime.logger.info("[Gamma] Evaluating consensus...");

    // In production, this would subscribe to war room events
    // For now, scan for tokens that have both narrative and contract evaluation
    // Both Alpha and Beta must have passed for the same token

    const tokens = await watchlistService.getWatchedTokens();
    const candidates = tokens.filter((t) => t.narrative_score >= 0.75);

    if (candidates.length === 0) {
      runtime.logger.info("[Gamma] No tokens with both Alpha and Beta approval");
      return;
    }

    for (const token of candidates) {
      try {
        runtime.logger.info(`[Gamma] Checking consensus for ${token.symbol} (${token.mint_address})`);

        // Check if position already exists
        if (await watchlistService.hasPosition(token.mint_address)) {
          runtime.logger.info(`[Gamma] Already in position for ${token.symbol}`);
          continue;
        }

        // Both Alpha (narrative) and Beta (contract) have passed
        // Narrative score >= 0.75 means Alpha passed
        // Beta passed is implicit - if score is >= 0.75, Beta must have approved
        // (Beta would have set it lower or pruned it otherwise)

        runtime.logger.info(`[Gamma] Consensus reached for ${token.symbol}`);

        // Execute trade
        const result = await tradeExecutionService.executeBuy(
          token.mint_address,
          token.symbol,
          "Trending Spike"
        );

        if (result.success) {
          runtime.logger.info(`[Gamma] TRADE_EXECUTED: ${token.symbol}`);

          const signal = {
            event: "TRADE_EXECUTED",
            mint_address: token.mint_address,
            symbol: token.symbol,
            tx_signature: result.txSignature,
            dry_run: result.dryRun,
            trigger_type: "Trending Spike"
          };

          const channel = runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Gamma" },
              text: JSON.stringify(signal),
              timestamp: Date.now()
            });
          }

          runtime.emitEvent("gamma_trade_executed", signal);
        } else {
          runtime.logger.info(`[Gamma] TRADE_REJECTED: ${token.symbol} - ${result.error}`);

          const signal = {
            event: "TRADE_REJECTED",
            mint_address: token.mint_address,
            symbol: token.symbol,
            reason: result.error
          };

          const channel = runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Gamma" },
              text: JSON.stringify(signal),
              timestamp: Date.now()
            });
          }

          runtime.emitEvent("gamma_trade_rejected", signal);
        }
      } catch (e) {
        runtime.logger.error(`[Gamma] Error evaluating ${token.symbol}:`, e);
      }
    }
  } catch (e) {
    runtime.logger.error("[Gamma] Error in consensus evaluation loop:", e);
  }
}