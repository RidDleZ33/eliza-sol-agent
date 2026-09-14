import { watchlistService } from "../services/WatchlistService.ts";
import { socialEvaluatorService, SocialTelemetry } from "../services/SocialEvaluatorService.ts";
import { configService } from "../services/ConfigService.ts";

interface AlphaEvaluationResult {
  score: number;
  communityOrganicity: number;
  reasoning: string;
}

export async function evaluateAlphaNarrative(runtime: any) {
  try {
    runtime.logger.info("[Alpha] Scanning pending/deferred tokens for narrative evaluation...");

    const tokensToEvaluate = await watchlistService.getTokensForAlphaEvaluation();
    if (tokensToEvaluate.length === 0) return;

    for (const token of tokensToEvaluate) {
      try {
        const telemetry = await socialEvaluatorService.evaluateToken(token.mint_address, token.symbol);
        const evalResult = await alphaEvaluateNarrative(runtime, token, telemetry);

        const minScore = configService.getNumber("MIN_NARRATIVE_SCORE");

        if (evalResult.score >= minScore && telemetry.botLikelihoodScore < 0.6) {
          // PASS -> Promote to Beta
          runtime.logger.info(`[Alpha] ${token.symbol} PASSED (${evalResult.score})`);
          await watchlistService.updateTokenStatus(token.mint_address, "ALPHA_PASSED", evalResult.score);

          const signal = {
            event: "NARRATIVE_EVALUATION_PASS",
            mint_address: token.mint_address,
            symbol: token.symbol,
            narrative_score: evalResult.score,
            reasoning: evalResult.reasoning
          };

          runtime.emitEvent("alpha_narrative_pass", signal);
        } else if (evalResult.score >= 0.5 && (token.eval_count || 0) < 3) {
          // DEFER -> Re-evaluate in 15 mins
          runtime.logger.info(`[Alpha] ${token.symbol} DEFERRED (${evalResult.score}). Retrying later.`);
          await watchlistService.deferToken(token.mint_address, 15);
        } else {
          // FAIL / PRUNE
          runtime.logger.info(`[Alpha] ${token.symbol} PRUNED (${evalResult.score}, BotScore: ${telemetry.botLikelihoodScore})`);
          await watchlistService.updateTokenStatus(token.mint_address, "PRUNED", evalResult.score, "LOW_SCORE_OR_BOT_SPAM");
        }
      } catch (e) {
        runtime.logger.error(`[Alpha] Error evaluating ${token.symbol}:`, e);
      }
    }
  } catch (e) {
    runtime.logger.error("[Alpha] Error in narrative evaluation loop:", e);
  }
}

async function alphaEvaluateNarrative(runtime: any, token: any, telemetry: SocialTelemetry): Promise<AlphaEvaluationResult> {
  const prompt = `You are Agent Alpha, a crypto narrative analyst. Evaluate this Solana token.

Token: $${token.symbol} (${token.mint_address})
DexScreener Platforms: ${telemetry.socialPlatforms.join(", ") || "None"}
Dex Boosted: ${telemetry.isDexBoosted ? "YES" : "NO"}
5m Buy/Sell Ratio: ${telemetry.buySellRatio5m.toFixed(2)}
Volume Acceleration (5m vs 1h): ${telemetry.txAcceleration5mVs1h.toFixed(2)}x
Detected Bot Spam Likelihood: ${(telemetry.botLikelihoodScore * 100).toFixed(0)}%

Recent Tweets Sample:
${telemetry.rawTextSamples.length > 0 ? telemetry.rawTextSamples.slice(0, 5).map(t => `- "${t}"`).join("\n") : "No tweets fetched"}

Return strictly valid JSON matching this schema:
{
  "score": <number 0.0 to 1.0>,
  "communityOrganicity": <number 0.0 to 1.0>,
  "reasoning": "<concise explanation>"
}`;

  try {
    const response = await runtime.generateText({
      messages: [{ role: "user", content: prompt }]
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.max(0, Math.min(1, Number(parsed.score) || 0.5)),
        communityOrganicity: Math.max(0, Math.min(1, Number(parsed.communityOrganicity) || 0.5)),
        reasoning: parsed.reasoning || "Evaluated by Agent Alpha"
      };
    }
  } catch (e) {
    runtime.logger.warn(`[Alpha] LLM evaluation failed for ${token.symbol}, falling back to heuristic:`, e.message);
  }

  // Fallback heuristic if LLM fails
  let score = 0.5;
  if (telemetry.hasSocialLinks) score += 0.15;
  if (telemetry.isDexBoosted) score += 0.10;
  if (telemetry.buySellRatio5m > 1.5) score += 0.10;
  if (telemetry.txAcceleration5mVs1h > 1.3) score += 0.10;
  if (telemetry.botLikelihoodScore > 0.5) score -= 0.25;

  return {
    score: Math.max(0, Math.min(1, score)),
    communityOrganicity: 1 - telemetry.botLikelihoodScore,
    reasoning: "Fallback heuristic evaluation based on volume acceleration and social links."
  };
}
