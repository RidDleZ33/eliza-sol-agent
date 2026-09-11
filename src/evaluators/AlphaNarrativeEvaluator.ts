import { watchlistService } from "../services/WatchlistService.ts";
import { socialEvaluatorService } from "../services/SocialEvaluatorService.ts";
import { configService } from "../services/ConfigService.ts";

export async function evaluateAlphaNarrative(runtime) {
  try {
    runtime.logger.info("[Alpha] Scanning watchlist for narrative evaluation...");

    const tokens = await watchlistService.getWatchedTokens();
    const tokensToEvaluate = tokens.filter((t) => t.narrative_score === 0.5);

    if (tokensToEvaluate.length === 0) {
      runtime.logger.info("[Alpha] No tokens requiring evaluation");
      return;
    }

    runtime.logger.info(`[Alpha] Evaluating ${tokensToEvaluate.length} tokens`);

    for (const token of tokensToEvaluate) {
      try {
        runtime.logger.info(`[Alpha] Evaluating ${token.symbol} (${token.mint_address})`);

        // Gather social telemetry
        const telemetry = await socialEvaluatorService.evaluateToken(
          token.mint_address,
          token.symbol
        );

        runtime.logger.info(`[Alpha] Telemetry for ${token.symbol}: hasSocial=${telemetry.hasSocialLinks}, buySellRatio=${telemetry.buySellRatio5m}`);

        // Use LLM to evaluate narrative strength
        const narrativeScore = await alphaEvaluateNarrative(runtime, token, telemetry);

        runtime.logger.info(`[Alpha] ${token.symbol} narrative score: ${narrativeScore}`);

        // Update watchlist score
        await watchlistService.updateTokenScore(token.mint_address, narrativeScore);

        // Emit signal based on score
        const minScore = configService.getNumber("MIN_NARRATIVE_SCORE");
        if (narrativeScore >= minScore) {
          // PASS: Signal to consensus room
          runtime.logger.info(`[Alpha] ${token.symbol} PASSED narrative evaluation (${narrativeScore})`);

          const signal = {
            event: "NARRATIVE_EVALUATION_PASS",
            mint_address: token.mint_address,
            symbol: token.symbol,
            narrative_score: narrativeScore,
            reasoning: `Organic sentiment ${telemetry.hasSocialLinks ? "with active social presence" : "based on volume analysis"}. Buy/sell ratio: ${telemetry.buySellRatio5m.toFixed(2)}`
          };

          // Write signal to consensus via ingest_signal action
          const signalMsg = {
            sender: "Alpha",
            role: "alpha",
            content: `NARRATIVE_EVALUATION_PASS: ${token.symbol} score=${narrativeScore}`,
            signal: {
              token_mint: token.mint_address,
              narrative_confidence: narrativeScore,
              token_symbol: token.symbol
            }
          };

          const channel = runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Alpha" },
              text: JSON.stringify(signal),
              timestamp: Date.now()
            });
          }

          runtime.emitEvent("alpha_narrative_pass", signal);
        } else if (narrativeScore < 0.5) {
          // FAIL: Remove from watchlist
          runtime.logger.info(`[Alpha] ${token.symbol} FAILED narrative evaluation (${narrativeScore}), pruning`);
          await watchlistService.removeToken(token.mint_address);
        } else {
          // NEUTRAL: Keep but mark evaluated
          runtime.logger.info(`[Alpha] ${token.symbol} neutral evaluation (${narrativeScore}), keeping in watchlist`);
        }
      } catch (e) {
        runtime.logger.error(`[Alpha] Error evaluating ${token.symbol}:`, e);
      }
    }
  } catch (e) {
    runtime.logger.error("[Alpha] Error in narrative evaluation loop:", e);
  }
}

async function alphaEvaluateNarrative(runtime, token, telemetry): Promise<number> {
  // Use LLM to evaluate narrative strength
  // Construct prompt with telemetry data
  const prompt = `You are Agent Alpha, the social and narrative evaluator. Evaluate the narrative strength of this Solana token on a scale of 0.0 to 1.0.

Token: ${token.symbol} (${token.mint_address})
Social footprint: ${telemetry.hasSocialLinks ? "Has social links (Twitter/Telegram/Website)" : "No social links found"}
Buy/Sell ratio (5m): ${telemetry.buySellRatio5m.toFixed(2)}
Recent tweet volume: ${telemetry.tweetVolume1h || "Unknown"}
24h Volume: $${(token.volume_24h / 1000000).toFixed(2)}M

${telemetry.rawTextSamples.length > 0 ? `Recent social posts:
${telemetry.rawTextSamples.join("\n")}` : ""}

Evaluate based on:
1. Community engagement quality (organic enthusiasm vs. bot spam)
2. Social footprint completeness
3. Short-term momentum velocity

Respond with ONLY a single number between 0.0 and 1.0 (e.g., 0.82). Do not include any other text.`;

  try {
    const response = await runtime.generateText({
      messages: [{ role: "user", content: prompt }]
    });

    // Extract score from response
    const match = response.match(/(\d+\.?\d*)/);
    if (match) {
      let score = parseFloat(match[1]);
      if (score > 1.0) score = 1.0;
      return Math.max(0.0, Math.min(1.0, score));
    }
  } catch (e) {
    runtime.logger.warn(`[Alpha] LLM evaluation failed for ${token.symbol}, using heuristic:`, e.message);
  }

  // Fallback heuristic
  let score = 0.5;
  if (telemetry.hasSocialLinks) score += 0.15;
  if (telemetry.buySellRatio5m > 1.5) score += 0.1;
  if (token.volume_24h > 10000000) score += 0.1;
  if (telemetry.tweetVolume1h && telemetry.tweetVolume1h > 5) score += 0.1;

  return Math.min(1.0, score);
}