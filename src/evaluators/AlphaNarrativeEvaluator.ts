import { watchlistService } from "../services/WatchlistService.ts";
import { socialEvaluatorService, SocialTelemetry } from "../services/SocialEvaluatorService.ts";
import { parseAndValidate, isAlphaVerdict } from "../utils/jsonParsing.ts";

export type DecisionType = "PASS" | "FAIL" | "DISSENT";

export interface AlphaVerdict {
  decision: DecisionType;
  confidenceRatio: number; // 0.0 to 1.0 rating weight for the committee
  narrativeScore: number;  // Overall narrative strength (0.0 - 1.0)
  organicityScore: number; // Real vs bot community activity (0.0 - 1.0)
  narrativeCategory: string; // e.g., "AI_AGENT", "CULTURE", "TIKTOK_MEME", "WEAK/GENERIC"
  reasoning: string;
}

export async function evaluateAlphaNarrative(runtime: any) {
  try {
    runtime.logger.info("[Alpha] Evaluating narrative for pending tokens...");
    const tokensToEvaluate = await watchlistService.getTokensForAlphaEvaluation();
    if (tokensToEvaluate.length === 0) {
      runtime.logger.info("[Alpha] No tokens ready for evaluation (all DEFERRED or already evaluated)");
      return;
    }
    runtime.logger.info(`[Alpha] Found ${tokensToEvaluate.length} tokens to evaluate`);

    for (const token of tokensToEvaluate) {
      try {
        const telemetry = await socialEvaluatorService.evaluateToken(token.mint_address, token.symbol);
        const verdict = await alphaEvaluateNarrative(runtime, token, telemetry);

        runtime.logger.info(`[Alpha] ${token.symbol} Verdict: ${verdict.decision} (Confidence: ${verdict.confidenceRatio}, Narrative: ${verdict.narrativeScore})`);

        await watchlistService.updateTokenAlphaVerdict(token.mint_address, verdict);

        runtime.emitEvent("alpha_evaluation_complete", {
          mint_address: token.mint_address,
          symbol: token.symbol,
          verdict
        });
      } catch (e) {
        runtime.logger.error(`[Alpha] Error evaluating ${token.symbol}:`, e);
      }
    }
  } catch (e) {
    runtime.logger.error("[Alpha] Evaluation loop error:", e);
  }
}

async function alphaEvaluateNarrative(runtime: any, token: any, telemetry: SocialTelemetry): Promise<AlphaVerdict> {
  const prompt = `You are Agent Alpha, sentiment and narrative specialist on a 3-agent Solana trading committee.

Analyze the sentiment, narrative virality, and organic momentum of this Solana token.

TOKEN DETAILS:
- Symbol: $${token.symbol}
- Mint Address: ${token.mint_address}
- DexScreener Platforms: ${telemetry.socialPlatforms.join(", ") || "None"}
- Dex Boosted: ${telemetry.isDexBoosted ? "YES" : "NO"}
- 5m Buy/Sell Ratio: ${telemetry.buySellRatio5m.toFixed(2)}
- 5m Volume Acceleration vs 1h: ${telemetry.txAcceleration5mVs1h.toFixed(2)}x
- Bot Spam Likelihood: ${(telemetry.botLikelihoodScore * 100).toFixed(0)}%
- Cashtag Spam Ratio: ${(telemetry.cashtagSpamRatio * 100).toFixed(0)}%

RECENT TWEETS SAMPLE:
${telemetry.rawTextSamples.length > 0 ? telemetry.rawTextSamples.slice(0, 8).map(t => `- "${t}"`).join("\n") : "No recent tweets fetched"}

COMMITTEE DECISION GUIDELINES:
1. PASS: Organic chatter, clear meme/narrative theme, reasonable bot score (< 40%). High confidence ratio (0.7 - 1.0).
2. FAIL: Low chatter, generic ticker, high bot farming (> 60%), or missing social presence.
3. DISSENT: Explicitly override expected market signals.
   - Bullish Dissent: High viral momentum/organic vibe despite low DEX metrics.
   - Bearish Dissent: Massive volume/price pump on DEX, but social chatter is strictly 90%+ bot farms or non-existent.

Respond STRICTLY in valid JSON:
{
  "decision": "PASS" | "FAIL" | "DISSENT",
  "confidenceRatio": <number 0.00 to 1.00>,
  "narrativeScore": <number 0.00 to 1.00>,
  "organicityScore": <number 0.00 to 1.00>,
  "narrativeCategory": "<AI_AGENT | MEME | CULTURE | UTILITY | WEAK>",
  "reasoning": "<1-2 sentence concise explanation>"
}`;

  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM Timeout')), 25000));
    const response: any = await Promise.race([runtime.generateText(prompt), timeout]);

    const responseStr = typeof response === 'string' ? response : String(response || '');

    const parsed = parseAndValidate(responseStr, isAlphaVerdict, "Alpha narrative response");

    if (parsed) {
      return {
        decision: ["PASS", "FAIL", "DISSENT"].includes(parsed.decision) ? parsed.decision : "FAIL",
        confidenceRatio: Math.max(0, Math.min(1, Number(parsed.confidenceRatio) || 0.5)),
        narrativeScore: Math.max(0, Math.min(1, Number(parsed.narrativeScore) || 0.0)),
        organicityScore: Math.max(0, Math.min(1, Number(parsed.organicityScore) || 0.0)),
        narrativeCategory: parsed.narrativeCategory || "WEAK",
        reasoning: parsed.reasoning || "Evaluated by Agent Alpha."
      };
    }
  } catch (e) {
    runtime.logger.warn(`[Alpha] LLM failed for ${token.symbol}, using fallback evaluation.`, e);
  }

  // Pure Heuristic Fallback
  const organicity = 1.0 - telemetry.botLikelihoodScore;
  const satisfiesSocials = telemetry.hasSocialLinks && telemetry.socialPlatforms.length > 0;
  
  if (!satisfiesSocials || telemetry.botLikelihoodScore > 0.65) {
    return {
      decision: "FAIL",
      confidenceRatio: 0.85,
      narrativeScore: 0.2,
      organicityScore: organicity,
      narrativeCategory: "WEAK",
      reasoning: "Fallback: Dead socials or high bot farming score."
    };
  }

  return {
    decision: "PASS",
    confidenceRatio: 0.50,
    narrativeScore: 0.55,
    organicityScore: organicity,
    narrativeCategory: "MEME",
    reasoning: "Fallback heuristic: Basic social channels present with acceptable bot ratio."
  };
}
