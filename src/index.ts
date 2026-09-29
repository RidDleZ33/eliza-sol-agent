import { requestAlphaTick } from "./evaluators/AlphaNarrativeEvaluator.ts";
import { evaluateBetaContract } from "./evaluators/BetaContractEvaluator.ts";
import { tradeExecutionService } from "./services/TradeExecutionService.ts";
import { evaluateGammaConsensus } from "./evaluators/GammaConsensusEvaluator.ts";
import { crashRecoveryService } from "./services/CrashRecoveryService.ts";
import { positionManagerService } from "./services/PositionManagerService.ts";
import { env, ingestFlag, getDexscreenerTrendingPeriod, getBirdeyeApiKey, getIngestionInterval } from "./utils/env.ts";
import { ingestionManager } from "./services/ingestion/IngestionManager.ts";
import { telegramAdminBot } from "./services/TelegramAdminBot.ts";
import { watchlistService } from "./services/WatchlistService.ts";
import { logger } from "./services/LoggerService.ts";
import { runInterlock } from "./boot/interlock.ts";
import { isDryRun } from "./utils/env.ts";
import { tier, can } from "./entitlements/tier.ts";

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("CONFIG", "Index", "Received shutdown signal", { signal });

  try {
    logger.info("CONFIG", "Index", "Stopping ingestion services...");
    ingestionManager.stop();

    logger.info("CONFIG", "Index", "Stopping position manager...");
    positionManagerService.stop();

    logger.info("CONFIG", "Index", "Closing watchlist database...");
    watchlistService.close();

    try {
      const timestamp = new Date().toISOString();
      const message = `AI Committee War Room Stopped
Time: ${timestamp}
Signal: ${signal}`;
      await telegramAdminBot.sendToChat(message);
      logger.info("TELEGRAM", "Index", "Shutdown notification sent to Telegram");
    } catch (e) {
      logger.warn("TELEGRAM", "Index", "Telegram notification failed", { error: e.message });
    }

    logger.info("CONFIG", "Index", "Graceful shutdown complete");
  } catch (e) {
    logger.error("CONFIG", "Index", "Error during shutdown", { error: e.message });
  } finally {
    process.exit(0);
  }
}

/**
 * Phase 0E: Boot services directly without ElizaOS.
 * Alpha uses src/llm/LlmClient.ts (OpenAI-compatible endpoint).
 * ElizaOS boot is opt-in via ELIZA_BOOT=1 (not yet implemented in this slice).
 */

// Adapter: Eliza-style single-string logs -> LoggerService four-slot API
function adaptLog(level: "info"|"warn"|"error"|"debug") {
  return (...args: any[]) => {
    // Detect Eliza-style (single string) vs proper four-slot call
    if (typeof args[0] === "string" && args.length >= 3 && typeof args[1] === "string") {
      // Already (category, component, message, extra?) - pass through
      (logger as any)[level](...args);
      return;
    }
    // Eliza-style: single message string
    const raw = args[0];
    const text = typeof raw === "string" ? raw : String(raw ?? "");
    // Match evaluator prefix specifically to avoid false positives (e.g. "ALPHA_PASSED" in Beta msg)
    let cat: "ALPHA"|"BETA"|"GAMMA"|"CONFIG" = "CONFIG";
    let comp = "Runtime";
    if (/^\[?(?:alpha|Alpha)/i.test(text)) { cat = "ALPHA"; comp = "ALPHA"; }
    else if (/^\[?(?:beta|Beta)/i.test(text)) { cat = "BETA"; comp = "BETA"; }
    else if (/^\[?(?:gamma|Gamma)/i.test(text)) { cat = "GAMMA"; comp = "GAMMA"; }
    // Handle extra: if second arg is object use as extra, else wrap
    let extra: Record<string, unknown> | undefined;
    if (args.length > 1) {
      if (typeof args[1] === "object" && args[1] !== null && !(args[1] instanceof Error)) {
        extra = args[1] as Record<string, unknown>;
      } else if (args[1] instanceof Error) {
        extra = { error: args[1].message ?? String(args[1]) };
      } else {
        extra = { detail: args[1] };
      }
    }
    (logger as any)[level](cat, comp, text, extra);
  };
}

// Stub runtime for evaluators that expect a runtime object
const stubRuntime = {
  logger: {
    info: adaptLog("info"),
    warn: adaptLog("warn"),
    error: adaptLog("error"),
    debug: adaptLog("debug")
  },
  getService: () => null,
  emitEvent: () => {}
};

async function main() {
  logger.info("CONFIG", "Index", "Initializing AI Committee (Phase 0E: services-only boot)...");
  logger.info("CONFIG", "Index", "LLM configuration", { url: env.OPENAI_BASE_URL || env.OLLAMA_BASE_URL, model: env.MODEL_NAME });

  // Phase 0F: boot interlock — compute and log mode, fail closed on LIVE if checks fail
  const interlock = runInterlock();

  // Phase 5A: entitlement gate — operator runs executor; lower tiers exit here
  if (!can("run_executor")) {
    logger.info("CONFIG", "Index", `entitlement tier ${tier()} cannot run executor; exiting`);
    process.exit(0);
  }

  // Run crash recovery before starting watchers
  try {
    await crashRecoveryService.reconcilePositions();
  } catch (e) {
    logger.error("CONFIG", "Index", "Crash recovery error", { error: e.message });
  }

  // Start position manager for auto-exit rules
  positionManagerService.start();

  tradeExecutionService.runtime = stubRuntime;

  // Phase 8D/8F: Beta first, then Alpha via requestAlphaTick (single-flight)
  const evalInterval = getIngestionInterval();
  logger.info("ALPHA", "Index", `eval intervalMs=${evalInterval}`);
  setInterval(async () => {
    try {
      // Phase 8F: Beta must run every interval regardless of Alpha backlog
      await evaluateBetaContract(stubRuntime);
    } catch (e) {
      logger.error("BETA", "Index", "Beta evaluator error", { error: e.message });
    }
    // Alpha via requestAlphaTick: coalesces overlapping interval fires
    requestAlphaTick();
  }, evalInterval);

  logger.info("CONFIG", "Index", "Scheduling Gamma evaluator (every 30s)");
  setInterval(async () => {
    try {
      await evaluateGammaConsensus(stubRuntime);
    } catch (e) {
      logger.error("CONFIG", "Index", "Gamma evaluator error", { error: e.message });
    }
  }, 30000);

  // Start ingestion services
  ingestionManager.start();

  // Phase 8D/8F: fire initial ticks after ingest is live — Beta first, then Alpha via requestAlphaTick
  logger.info("CONFIG", "Index", "Firing initial evaluator ticks (post-ingest)");
  try { await evaluateBetaContract(stubRuntime); } catch (e) { logger.error("BETA", "Index", "Initial Beta error", { error: e.message }); }
  requestAlphaTick();
  try { await evaluateGammaConsensus(stubRuntime); } catch (e) { logger.error("GAMMA", "Index", "Initial Gamma error", { error: e.message }); }

  // Phase 6D/7B: boot visibility — log exactly which sources are enabled
  const dsLatest = ingestFlag("INGEST_DEXSCREENER_LATEST") ? "ON" : "OFF";
  const dsTrending = ingestFlag("INGEST_DEXSCREENER_TRENDING") ? "ON" : "OFF";
  const period = getDexscreenerTrendingPeriod();
  const bullish = ingestFlag("INGEST_DEXSCREENER_TRENDING_BULLISH") ? "ON" : "OFF";
  let birdeyeLabel = "OFF";
  if (ingestFlag("INGEST_BIRDEYE_TRENDING")) {
    birdeyeLabel = getBirdeyeApiKey() ? "ON" : "NO_KEY";
  }
  // Phase 7B: new_listing replaces dead DexScreener /tokens/latest/v1 (404)
  let newListingLabel = "OFF";
  if (ingestFlag("INGEST_BIRDEYE_NEW_LISTING")) {
    newListingLabel = getBirdeyeApiKey() ? "ON" : "NO_KEY";
  }
  const phantom = ingestFlag("INGEST_PHANTOM") ? "ON" : "OFF";
  logger.info("INGESTION", "Index", `ingest sources: ds_latest=${dsLatest} ds_trending=${dsTrending} period=${period} bullish=${bullish} birdeye=${birdeyeLabel} new_listing=${newListingLabel} phantom=${phantom}`);

  logger.info("CONFIG", "Index", "AI Committee services initialized.");

  // Start Telegram Admin Bot LAST so startup notification is sent after it's ready
  logger.info("TELEGRAM", "Index", "Starting Telegram Admin Bot...");
  try {
    await telegramAdminBot.start();
    logger.info("TELEGRAM", "Index", "Telegram Admin Bot started successfully");

    // Send startup notification via the admin bot
    const timestamp = new Date().toISOString();
    const modeLabel = isDryRun() ? "DRY_RUN" : "LIVE";
    const tradesCount = watchlistService.listRecentTrades(1).length;
    const message = `AI Committee War Room Started
Time: ${timestamp}

Agents: Alpha, Beta, Gamma
Monitoring Solana ecosystem
Consensus room active
Mode: ${modeLabel}
trades_db: watchlist (${tradesCount} trades)`;
    await telegramAdminBot.sendToChat(message);
    logger.info("TELEGRAM", "Index", "Startup notification sent to Telegram");
  } catch (e) {
    logger.warn("TELEGRAM", "Index", "Telegram admin bot failed", { error: e.message });
  }

  // Register shutdown handlers
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("CONFIG", "Index", "Uncaught exception", { error: err.message });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("CONFIG", "Index", "Unhandled promise rejection", { reason: String(reason) });
  });

  await new Promise(() => {});
}

main().catch(console.error);