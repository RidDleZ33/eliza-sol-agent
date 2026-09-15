import { ElizaOS } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { consensusPlugin } from "./plugins/consensus/index.ts";
import { tradingExecutionPlugin } from "./plugins/trading-execution/index.ts";
import { solanaPlugin } from "@elizaos/plugin-solana";
import { jupiterPlugin } from "@elizaos/plugin-jupiter";
import { watchlistPlugin } from "./plugins/watchlist/index.ts";
import { evaluateAlphaNarrative } from "./evaluators/AlphaNarrativeEvaluator.ts";
import { evaluateBetaContract } from "./evaluators/BetaContractEvaluator.ts";
import { walletMirrorService } from "./services/WalletMirrorService.ts";
import { tradeExecutionService } from "./services/TradeExecutionService.ts";
import { evaluateGammaConsensus } from "./evaluators/GammaConsensusEvaluator.ts";
import { crashRecoveryService } from "./services/CrashRecoveryService.ts";
import { positionManagerService } from "./services/PositionManagerService.ts";
import { env } from "./utils/env.ts";
import { spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

import { ingestionManager } from "./services/ingestion/IngestionManager.ts";
import { configService } from "./services/ConfigService.ts";
import { telegramAdminBot } from "./services/TelegramAdminBot.ts";
import { watchlistService } from "./services/WatchlistService.ts";
import { logger } from "./services/LoggerService.ts";
import { ensureWarRoomJoined } from "./utils/warRoom.ts";

const sleep = promisify(setTimeout);

function loadCharacter(path: string) {
  const content = fs.readFileSync(path, "utf-8");
  return JSON.parse(content);
}

async function startWebUI(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = spawn("npx", ["http-server", "node_modules/@elizaos/ui/dist", "-a", "0.0.0.0", "-p", String(port), "-s"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let resolved = false;
    server.stdout?.on("data", (data) => {
      if (!resolved) {
        logger.info("CONFIG", "WebUI", "Web UI started", { url: data.toString().trim() });
        resolved = true;
        resolve();
      }
    });

    server.stderr?.on("data", (data) => {
      logger.warn("CONFIG", "WebUI", "Web UI error", { error: data.toString().trim() });
    });

    setTimeout(() => {
      if (!resolved) {
        logger.info("CONFIG", "WebUI", "Web UI server started", { port });
        resolve();
      }
    }, 3000);
  });
}

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

async function main() {
  logger.info("CONFIG", "Index", "Initializing AI Committee...");
  logger.info("CONFIG", "Index", "LLM configuration", { url: env.OLLAMA_BASE_URL, model: env.MODEL_NAME });
  logger.info("CONFIG", "Index", "Web UI configuration", { port: env.ELIZAOS_WEB_PORT });

  const port = parseInt(env.ELIZAOS_WEB_PORT);
  await startWebUI(port);

  process.env.OPENAI_BASE_URL = env.OLLAMA_BASE_URL;
  process.env.OPENAI_API_KEY = env.OLLAMA_API_KEY;

  const alphaCharacter = loadCharacter("./characters/alpha.json");
  const betaCharacter = loadCharacter("./characters/beta.json");
  const gammaCharacter = loadCharacter("./characters/gamma.json");

  const elizaOS = new ElizaOS();

  logger.info("CONFIG", "Index", "Adding agents to swarm...");
  const agentIds = await elizaOS.addAgents(
    [
      { character: alphaCharacter, plugins: [consensusPlugin, watchlistPlugin, solanaPlugin, openaiPlugin, sqlPlugin] },
      { character: betaCharacter, plugins: [consensusPlugin, watchlistPlugin, solanaPlugin, openaiPlugin, sqlPlugin] },
      { character: gammaCharacter, plugins: [consensusPlugin, tradingExecutionPlugin, jupiterPlugin, openaiPlugin, sqlPlugin] }
    ],
    { autoStart: true }
  );

  // Get runtimes and schedule evaluator loops
  const runtimes = elizaOS.getAgents();
  const alphaRuntime = runtimes.find(r => r.character.name === "Alpha");
  const betaRuntime = runtimes.find(r => r.character.name === "Beta");
  const gammaRuntime = runtimes.find(r => r.character.name === "Gamma");

  // Initialize War Room for all agents
  logger.info("CONFIG", "Index", "Joining agents to War Room...");
  for (const runtime of runtimes) {
    try {
      await ensureWarRoomJoined(runtime);
    } catch (e) {
      logger.error("CONFIG", "Index", `Failed to join ${runtime.character.name} to War Room`, { error: e.message });
    }
  }

  if (alphaRuntime) {
    logger.info("CONFIG", "Index", "Scheduling Alpha evaluator (every 3m)");
    setInterval(async () => {
      try {
        await evaluateAlphaNarrative(alphaRuntime);
      } catch (e) {
        logger.error("CONFIG", "Index", "Alpha evaluator error", { error: e.message });
      }
    }, 180000);
  }

  if (betaRuntime) {
    logger.info("CONFIG", "Index", "Scheduling Beta evaluator (every 2m)");
    setInterval(async () => {
      try {
        await evaluateBetaContract(betaRuntime);
      } catch (e) {
        logger.error("CONFIG", "Index", "Beta evaluator error", { error: e.message });
      }
    }, 120000);
  }

  if (gammaRuntime) {
    logger.info("CONFIG", "Index", "Scheduling Gamma evaluator (every 30s)");
    setInterval(async () => {
      try {
        await evaluateGammaConsensus(gammaRuntime);
      } catch (e) {
        logger.error("CONFIG", "Index", "Gamma evaluator error", { error: e.message });
      }
    }, 30000);
  }

  logger.info("CONFIG", "Index", "AI Committee initialized. Three agents online.");

  // Initialize dynamic configuration manager
  logger.info("CONFIG", "Index", "Initializing configuration service...");

  // Run crash recovery before starting watchers
  await crashRecoveryService.reconcilePositions();

  // Start position manager for auto-exit rules
  positionManagerService.start();

  // Start ingestion services
  ingestionManager.start();
  logger.info("CONFIG", "Index", "Shared consensus room active.");
  logger.info("CONFIG", "Index", "War room URL", { url: `http://localhost:${port}` });

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