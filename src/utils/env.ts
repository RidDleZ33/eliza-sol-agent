import { z } from "zod";
import * as dotenv from "dotenv";
dotenv.config();

const EnvSchema = z.object({
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  JITO_URL: z.string().default("https://mainnet.block-engine.jito.wtf/api/v1/bundles"),
  JITO_AUTH_KEYPAIR: z.string().optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  MODEL_NAME: z.string().default("qwen2.5-coder:27b"),
  SHARED_ROOM: z.string().default("ai-committee-war-room"),
  MAX_TRADE_SIZE_SOL: z.string().default("0.5"),
  SLIPPAGE_BPS: z.string().default("50"),
  DRY_RUN: z.string().optional(),
  GAMMA_PRIVATE_KEY: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

export function isDryRun(): boolean {
  return env.DRY_RUN === "true" || env.DRY_RUN === "1";
}

export function getMaxTradeSizeSol(): number {
  return parseFloat(env.MAX_TRADE_SIZE_SOL);
}

export function getSlippageBps(): number {
  return parseInt(env.SLIPPAGE_BPS);
}
