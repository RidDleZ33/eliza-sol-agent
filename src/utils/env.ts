import { z } from "zod";
import * as dotenv from "dotenv";
dotenv.config();

const EnvSchema = z.object({
  OLLAMA_BASE_URL: z.string().default("http://arceus:11434"),
  MODEL_NAME: z.string().default("qwen2.5:3b"),
  ELIZAOS_WEB_PORT: z.string().default("8007"),
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  JITO_URL: z.string().default("https://mainnet.block-engine.jito.wtf/api/v1/bundles"),
  JITO_AUTH_KEYPAIR: z.string().optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  GAMMA_PRIVATE_KEY: z.string().optional(),
  SOLANA_PRIVATE_KEY: z.string().optional(),
  MAX_TRADE_SIZE_SOL: z.string().default("0.5"),
  SLIPPAGE_BPS: z.string().default("50"),
  DRY_RUN: z.string().optional(),
  SHARED_ROOM: z.string().default("ai-committee-war-room"),
  MAX_TRENDING_TOKENS: z.string().default("10"),
  MAX_TOP_TRADERS: z.string().default("15"),
  BIRDEYE_API_KEY: z.string().optional(),
  INGESTION_INTERVAL_MS: z.string().default("60000"),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  WALLET_MIRROR_INTERVAL_MS: z.string().default("20000"),
  RUGCHECK_API_URL: z.string().default("https://api.rugcheck.xyz/v1/tokens"),
  MIN_LIQUIDITY_USD: z.string().default("10000"),
  MAX_TOP10_CONCENTRATION_PCT: z.string().default("25"),
  JITO_TIP_LAMPORTS: z.string().default("100000"),
  MAX_CONCURRENT_POSITIONS: z.string().default("3"),
  DRY_RUN_MODE: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

export function isDryRun(): boolean {
  return env.DRY_RUN === "true" || env.DRY_RUN === "1" || env.DRY_RUN_MODE === "true";
}

export function getMaxTradeSizeSol(): number {
  return parseFloat(env.MAX_TRADE_SIZE_SOL);
}

export function getSlippageBps(): number {
  return parseInt(env.SLIPPAGE_BPS);
}

export function getMaxTrendingTokens(): number {
  return parseInt(env.MAX_TRENDING_TOKENS);
}

export function getMaxTopTraders(): number {
  return parseInt(env.MAX_TOP_TRADERS);
}

export function getBirdeyeApiKey(): string | undefined {
  return env.BIRDEYE_API_KEY;
}

export function getIngestionInterval(): number {
  return parseInt(env.INGESTION_INTERVAL_MS);
}

export function getTwitterBearerToken(): string | undefined {
  return env.TWITTER_BEARER_TOKEN;
}

export function getWalletMirrorInterval(): number {
  return parseInt(env.WALLET_MIRROR_INTERVAL_MS);
}

export function getRugcheckApiUrl(): string {
  return env.RUGCHECK_API_URL;
}

export function getMinLiquidityUsd(): number {
  return parseInt(env.MIN_LIQUIDITY_USD);
}

export function getMaxTop10ConcentrationPct(): number {
  return parseInt(env.MAX_TOP10_CONCENTRATION_PCT);
}

export function getJitoTipLamports(): number {
  return parseInt(env.JITO_TIP_LAMPORTS);
}

export function getMaxConcurrentPositions(): number {
  return parseInt(env.MAX_CONCURRENT_POSITIONS);
}

export function getSolanaPrivateKey(): string | undefined {
  return env.SOLANA_PRIVATE_KEY;
}
