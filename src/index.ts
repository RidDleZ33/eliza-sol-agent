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
import { env } from "./utils/env.ts";
import { spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import { sendTelegramMessage } from "./utils/telegram.ts";
import { ingestionManager } from "./services/ingestion/IngestionManager.ts";

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
        console.log(`Web UI: ${data.toString().trim()}`);
        resolved = true;
        resolve();
      }
    });

    server.stderr?.on("data", (data) => {
      console.error(`Web UI Error: ${data.toString().trim()}`);
    });

    setTimeout(() => {
      if (!resolved) {
        console.log(`Web UI server started on port ${port}`);
        resolve();
      }
    }, 3000);
  });
}

async function main() {
  console.log("Initializing AI Committee...");
  console.log(`LLM: ${env.OLLAMA_BASE_URL}/${env.MODEL_NAME}`);
  console.log(`Web UI: http://localhost:${env.ELIZAOS_WEB_PORT}`);

  const port = parseInt(env.ELIZAOS_WEB_PORT);
  await startWebUI(port);

  process.env.OPENAI_BASE_URL = env.OLLAMA_BASE_URL;
  process.env.OPENAI_API_KEY = env.OLLAMA_API_KEY;

  const alphaCharacter = loadCharacter("./characters/alpha.json");
  const betaCharacter = loadCharacter("./characters/beta.json");
  const gammaCharacter = loadCharacter("./characters/gamma.json");

  const elizaOS = new ElizaOS();

  console.log("Adding agents to swarm...");
  const agentIds = await elizaOS.addAgents(
    [
      { character: alphaCharacter, plugins: [consensusPlugin, watchlistPlugin, openaiPlugin, sqlPlugin], evaluator: evaluateAlphaNarrative, evaluatorIntervalMs: 180000 },
      { character: betaCharacter, plugins: [consensusPlugin, watchlistPlugin, solanaPlugin, openaiPlugin, sqlPlugin], evaluator: evaluateBetaContract, evaluatorIntervalMs: 120000 },
      { character: gammaCharacter, plugins: [consensusPlugin, tradingExecutionPlugin, jupiterPlugin, openaiPlugin, sqlPlugin], evaluator: evaluateGammaConsensus, evaluatorIntervalMs: 30000 },
    ],
    { autoStart: true }
  );

  console.log("AI Committee initialized. Three agents online.");

  // Start ingestion services
  ingestionManager.start();
  console.log("Shared consensus room active.");
  console.log(`\nVisit http://localhost:${port} to monitor the war room.`);

  try {
    const timestamp = new Date().toISOString();
    const message = "AI Committee War Room Started\n" +
      `Time: ${timestamp}\n\n` +
      "Agents: Alpha, Beta, Gamma\n" +
      "Monitoring Solana ecosystem\n" +
      "Consensus room active\n" +
      "Trading in DRY_RUN mode";
    await sendTelegramMessage(message);
    console.log("Startup notification sent to Telegram");
  } catch (e) {
    console.log(`Telegram notification failed: ${e.message}`);
  }

  await new Promise(() => {});
}

main().catch(console.error);