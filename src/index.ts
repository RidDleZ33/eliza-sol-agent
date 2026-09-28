import { evaluateAlphaNarrative } from "./evaluators/AlphaNarrativeEvaluator.ts";
import { evaluateBetaContract } from "./evaluators/BetaContractEvaluator.ts";
import { tradeExecutionService } from "./services/TradeExecutionService.ts";
import { evaluateGammaConsensus } from "./evaluators/GammaConsensusEvaluator.ts";
import { crashRecoveryService } from "./services/CrashRecoveryService.ts";
import { positionManagerService } from "./services/PositionManagerService.ts";
import { env } from "./utils/env.ts";
import { ingestionManager } from "./services/ingestion/IngestionManager.ts";
import { telegramAdminBot } from "./services/TelegramAdminBot.ts";
import { watchlistService } from "./services/WatchlistService.ts";
import { logger } from "./services/LoggerService.ts";

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

// Stub runtime for evaluators that expect a runtime object
const stubRuntime = {
  logger: {
    info: (...args: any[]) => logger.info(...args),
    warn: (...args: any[]) => logger.warn(...args),
    error: (...args: any[]) => logger.error(...args),
    debug: (...args: any[]) => logger.debug(...args)
  },
  getService: () => null,
  emitEvent: () => {}
};

async function main() {
  logger.info("CONFIG", "Index", "Initializing AI Committee (Phase 0E: services-only boot)...");
  logger.info("CONFIG", "Index", "LLM configuration", { url: env.OPENAI_BASE_URL || env.OLLAMA_BASE_URL, model: env.MODEL_NAME });

  // Run crash recovery before starting watchers
  try {
    await crashRecoveryService.reconcilePositions();
  } catch (e) {
    logger.error("CONFIG", "Index", "Crash recovery error", { error: e.message });
  }

  // Start position manager for auto-exit rules
  positionManagerService.start();

  // Schedule evaluator loops using stub runtime
  logger.info("CONFIG", "Index", "Scheduling Alpha evaluator (every 3m)");
  setInterval(async () => {
    try {
      await evaluateAlphaNarrative(stubRuntime);
    } catch (e) {
      logger.error("CONFIG", "Index", "Alpha evaluator error", { error: e.message });
    }
  }, 180000);

  logger.info("CONFIG", "Index", "Scheduling Beta evaluator (every 2m)");
  setInterval(async () => {
    try {
      await evaluateBetaContract(stubRuntime);
    } catch (e) {
      logger.error("CONFIG", "Index", "Beta evaluator error", { error: e.message });
    }
  }, 120000);

  tradeExecutionService.runtime = stubRuntime;
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

  logger.info("CONFIG", "Index", "AI Committee services initialized.");

  // Start Telegram Admin Bot LAST so startup notification is sent after it's ready
  logger.info("TELEGRAM", "Index", "Starting Telegram Admin Bot...");
  try {
    await telegramAdminBot.start();
    logger.info("TELEGRAM", "Index", "Telegram Admin Bot started successfully");

    // Send startup notification via the admin bot
    const timestamp = new Date().toISOString();
    const message = `AI Committee War Room Started
Time: ${timestamp}

Agents: Alpha, Beta, Gamma
Monitoring Solana ecosystem
Consensus room active
Trading in DRY_RUN mode`;
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