import { watchlistService } from "../services/WatchlistService.ts";
import { socialEvaluatorService, SocialTelemetry } from "../services/SocialEvaluatorService.ts";
import { postWarRoomMessage } from "../services/WarRoomService.ts";
import { llmComplete } from "../llm/LlmClient.ts";
import { logger } from "../services/LoggerService.ts";

export type DecisionType = "PASS" | "FAIL" | "DISSENT" | "DEFER";

export interface AlphaVerdict {
  decision: DecisionType;
  confidenceRatio: number;
  narrativeScore: number;
  organicityScore: number;
  narrativeCategory: string;
  reasoning: string;
  used_fallback: boolean;
}

export async function evaluateAlphaNarrative(_runtime?: any) {
  try {
    logger.info("ALPHA", "AlphaNarrativeEvaluator", "Evaluating narrative for pending tokens...");
    const tokensToEvaluate = await watchlistService.getTokensForAlphaEvaluation();

    if (tokensToEvaluate.length === 0) {
      logger.info("ALPHA", "AlphaNarrativeEvaluator", "No tokens ready for evaluation (all DEFERRED or already evaluated)");
      return;
    }
    logger.info("ALPHA", "AlphaNarrativeEvaluator", `Found ${tokensToEvaluate.length} tokens to evaluate`);

    for (const token of tokensToEvaluate) {
      try {
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `Starting evaluation for ${token.symbol} (${token.mint_address})`);

        // Collect social telemetry
        const telemetry = await socialEvaluatorService.evaluateToken(token.mint_address, token.symbol);
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `Social telemetry for ${token.symbol}: ${telemetry.tweetVolume1h} tweets, bot likelihood ${(telemetry.botLikelihoodScore * 100).toFixed(0)}%, platforms: ${telemetry.socialPlatforms.join(",") || "none"}`);

        // Evaluate via LLM
        const verdict = await alphaEvaluateNarrative(token, telemetry);

        // Log detailed verdict
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `${token.symbol} Verdict: ${verdict.decision}`);
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `  Confidence: ${verdict.confidenceRatio}, Narrative: ${verdict.narrativeScore}, Organicity: ${verdict.organicityScore}`);
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `  Category: ${verdict.narrativeCategory}`);
        logger.info("ALPHA", "AlphaNarrativeEvaluator", `  Reasoning: ${verdict.reasoning}`);

        // War room: broadcast evaluation decision
        if (verdict.decision === "DEFER") {
          await postWarRoomMessage("ALPHA", "VOTE_CAST", {
            symbol: token.symbol,
            decision: "HOLD",
            confidence: verdict.confidenceRatio,
            reasoning: `Deferred - insufficient data`
          });
        } else {
          await postWarRoomMessage("ALPHA", "VOTE_CAST", {
            symbol: token.symbol,
            decision: verdict.decision === "PASS" ? "BUY" : "SELL",
            confidence: verdict.confidenceRatio,
            reasoning: verdict.reasoning
          });
        }

        // Handle DEFER by setting future evaluation time instead of storing verdict
        if (verdict.decision === "DEFER") {
          const deferMinutes = Math.max(10, Math.min(120, Math.round((1 - verdict.confidenceRatio) * 120)));
          logger.info("ALPHA", "AlphaNarrativeEvaluator", `${token.symbol} DEFERRED for ${deferMinutes} minutes (confidence: ${verdict.confidenceRatio})`);
          await watchlistService.deferToken(token.mint_address, deferMinutes);
        } else {
          await watchlistService.updateTokenAlphaVerdict(token.mint_address, verdict);
        }
      } catch (e) {
        logger.error("ALPHA", "AlphaNarrativeEvaluator", `Error evaluating ${token.symbol}`, { error: e });
      }
    }
  } catch (e) {
    logger.error("ALPHA", "AlphaNarrativeEvaluator", "Evaluation loop error", { error: e });
  }
}

async function alphaEvaluateNarrative(token: any, telemetry: SocialTelemetry): Promise<AlphaVerdict> {
  logger.info("ALPHA", "AlphaNarrativeEvaluator", `Calling LLM for narrative evaluation of ${token.symbol}...`);

  const prompt = `You are Agent Alpha, a narrative and organicity scorer on a 3-agent Solana trading committee.

You score narrative quality and social organicity. You do not size, route, or exit positions.

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
4. DEFER: Insufficient data for confident assessment. Token is new or activity is too low to judge. Recommend re-evaluating later.

Respond STRICTLY in valid JSON:
{
  "decision": "PASS" | "FAIL" | "DISSENT" | "DEFER",
  "confidenceRatio": <number 0.00 to 1.00>,
  "narrativeScore": <number 0.00 to 1.00>,
  "organicityScore": <number 0.00 to 1.00>,
  "narrativeCategory": "<AI_AGENT | MEME | CULTURE | UTILITY | WEAK>",
  "reasoning": "<one sentence, no trade verbs like buy/sell/swap>"
}`;

  const result = await llmComplete(prompt, { json: true });

  if (result.parsed) {
    const parsed = result.parsed as any;
    const validDecisions = ["PASS", "FAIL", "DISSENT", "DEFER"];
    
    // Trade verb detection: if model tries to give trade instructions, treat as DEFER
    const reasoningLower = (parsed.reasoning || "").toLowerCase();
    const hasTradeVerbs = /(?:^|\s)(?:buy|sell|swap|exit|close|take size|scale in|scale out)(?:\s|$)/i.test(reasoningLower) ||
      /\bsol\b/i.test(reasoningLower);
    if (hasTradeVerbs) {
      logger.warn("ALPHA", "AlphaNarrativeEvaluator", `Trade verbs detected in reasoning for ${token.symbol}, deferring`);
      return {
        decision: "DEFER",
        confidenceRatio: 0.3,
        narrativeScore: 0.0,
        organicityScore: 0.0,
        narrativeCategory: "WEAK",
        reasoning: "Reasoning contained trade verbs (buy/sell/swap/sol).",
        used_fallback: true
      };
    }
    
    if (!validDecisions.includes(parsed.decision)) {
      logger.warn("ALPHA", "AlphaNarrativeEvaluator", `Invalid decision from LLM for ${token.symbol}: ${parsed.decision}`);
      return {
        decision: "DEFER",
        confidenceRatio: 0.3,
        narrativeScore: 0.0,
        organicityScore: 0.0,
        narrativeCategory: "WEAK",
        reasoning: "LLM response format invalid.",
        used_fallback: true
      };
    }
    return {
      decision: parsed.decision as DecisionType,
      confidenceRatio: Math.max(0, Math.min(1, Number(parsed.confidenceRatio) || 0.5)),
      narrativeScore: Math.max(0, Math.min(1, Number(parsed.narrativeScore) || 0.0)),
      organicityScore: Math.max(0, Math.min(1, Number(parsed.organicityScore) || 0.0)),
      narrativeCategory: parsed.narrativeCategory || "WEAK",
      reasoning: parsed.reasoning || "Evaluated by Agent Alpha.",
      used_fallback: false
    };
  }

  // LLM timeout or parse fail -> fail closed to DEFER, not heuristic PASS
  logger.warn("ALPHA", "AlphaNarrativeEvaluator", `LLM failed or unparseable for ${token.symbol}, deferring`);
  return {
    decision: "DEFER",
    confidenceRatio: 0.3,
    narrativeScore: 0.0,
    organicityScore: 0.0,
    narrativeCategory: "WEAK",
    reasoning: "LLM unavailable or response unparseable. Deferring.",
    used_fallback: true
  };
}
