import { ElizaOS } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { consensusPlugin } from "./plugins/consensus/index.ts";
import { tradingExecutionPlugin } from "./plugins/trading-execution/index.ts";
import { solanaPlugin } from "@elizaos/plugin-solana";
import { jupiterPlugin } from "@elizaos/plugin-jupiter";
import { env } from "./utils/env.ts";
import { spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const sleep = promisify(setTimeout);

function loadCharacter(path: string) {
  const content = fs.readFileSync(path, "utf-8");
  return JSON.parse(content);
}

async function startWebUI(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = spawn("npx", ["http-server", "node_modules/@elizaos/ui/dist", "-p", String(port), "-s"], {
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

  // Start web UI first
  const port = parseInt(env.ELIZAOS_WEB_PORT);
  await startWebUI(port);

  // Configure OpenAI plugin to use Ollama endpoint
  process.env.OPENAI_BASE_URL = env.OLLAMA_BASE_URL;
  process.env.OPENAI_API_KEY = env.OLLAMA_API_KEY;

  // Load character configs from JSON files
  const alphaCharacter = loadCharacter("./characters/alpha.json");
  const betaCharacter = loadCharacter("./characters/beta.json");
  const gammaCharacter = loadCharacter("./characters/gamma.json");

  // Create ElizaOS instance - runtime handles database adapter and migrations automatically
  const elizaOS = new ElizaOS();

  console.log("Adding agents to swarm...");
  const agentIds = await elizaOS.addAgents(
    [
      {
        character: alphaCharacter,
        plugins: [consensusPlugin, openaiPlugin, sqlPlugin],
      },
      {
        character: betaCharacter,
        plugins: [consensusPlugin, solanaPlugin, openaiPlugin, sqlPlugin],
      },
      {
        character: gammaCharacter,
        plugins: [consensusPlugin, tradingExecutionPlugin, jupiterPlugin, openaiPlugin, sqlPlugin],
      },
    ],
    { autoStart: true }
  );

  console.log("AI Committee initialized. Three agents online.");
  console.log("Shared consensus room active.");
  console.log(`\nVisit http://localhost:${port} to monitor the war room.`);

  // Keep process alive
  await new Promise(() => {});
}

main().catch(console.error);