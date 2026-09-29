import { z } from "zod";
import * as dotenv from "dotenv";
dotenv.config();

const EnvSchema = z.object({
  OPENAI_BASE_URL: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_URL || "http://arceus:11434/v1"),
  OLLAMA_API_KEY: z.string().default(process.env.OPENAI_API_KEY || "ollama"),
  MODEL_NAME: z.string().default(process.env.LARGE_OPENAI_MODEL || "qwen2.5:3b"),
  ELIZAOS_WEB_PORT: z.string().default("8007"),
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  JITO_URL: z.string().default("https://mainnet.block-engine.jito.wtf/api/v1/bundles"),
  JITO_AUTH_KEYPAIR: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  GAMMA_PRIVATE_KEY: z.string().optional(),
  SOLANA_PRIVATE_KEY: z.string().optional(),
  MAX_TRADE_SIZE_SOL: z.string().default("0.5"),
  MAX_DEPLOYED_SOL: z.string().default("2.0"),
  MAX_DAILY_LOSS_SOL: z.string().default("0.5"),
  KILL_SWITCH: z.string().optional(),
  SLIPPAGE_BPS: z.string().default("50"),
  DRY_RUN: z.string().optional(),
  SHARED_ROOM: z.string().default("ai-committee-war-room"),
  MAX_TRENDING_TOKENS: z.string().default("10"),
  MAX_TOP_TRADERS: z.string().default("15"),
  BIRDEYE_API_KEY: z.string().optional(),
  INGESTION_INTERVAL_MS: z.string().default("60000"),
  INGEST_DEXSCREENER_LATEST: z.string().default("false"),
  INGEST_DEXSCREENER_TRENDING: z.string().default("false"),
  INGEST_DEXSCREENER_TRENDING_PERIOD: z.string().default("1h"),
  INGEST_DEXSCREENER_TRENDING_BULLISH: z.string().default("false"),
  INGEST_BIRDEYE_TRENDING: z.string().default("true"),
  INGEST_BIRDEYE_NEW_LISTING: z.string().default("true"),
  INGEST_BIRDEYE_TOP_TRADERS: z.string().default("false"),
  INGEST_PHANTOM: z.string().default("false"),
  INGEST_DEXSCREENER_CHAIN: z.string().default("solana"),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  WALLET_MIRROR_INTERVAL_MS: z.string().default("20000"),
  RUGCHECK_API_URL: z.string().default("https://api.rugcheck.xyz/v1/tokens"),
  MIN_LIQUIDITY_USD: z.string().default("10000"),
  MAX_TOP10_CONCENTRATION_PCT: z.string().default("25"),
  JITO_TIP_LAMPORTS: z.string().default("100000"),
  MAX_CONCURRENT_POSITIONS: z.string().default("3"),
  DRY_RUN_MODE: z.string().optional(),
  TAKE_PROFIT_PCT: z.string().default("50"),
  STOP_LOSS_PCT: z.string().default("15"),
  EXIT_ATR_K: z.string().default("1.5"),
  TRAILING_STOP_PCT: z.string().default("10"),
  STALE_POSITION_MINUTES: z.string().default("30"),
  POSITION_CHECK_INTERVAL_MS: z.string().default("5000"),
});

export const env = EnvSchema.parse(process.env);

function isTruthyFlag(val: string | undefined): boolean {
  return val === "true" || val === "1";
}

/**
 * Unified dry-run check (phase 0C).
 *
 * Rules:
 *   - Either DRY_RUN or DRY_RUN_MODE set true/1 → dry-run
 *   - Both set and disagree → dry-run + loud error (fail closed)
 *   - Neither or both explicitly false → live
 */
let _dryRunComputed = false;
let _dryRunValue = false;

export function isDryRun(): boolean {
  if (_dryRunComputed) return _dryRunValue;
  _dryRunComputed = true;

  const dryRun = isTruthyFlag(env.DRY_RUN);
  const dryRunMode = isTruthyFlag(env.DRY_RUN_MODE);

  if (dryRun || dryRunMode) {
    _dryRunValue = true;
    if (env.DRY_RUN !== undefined && env.DRY_RUN_MODE !== undefined && dryRun !== dryRunMode) {
      console.error("[risk] DRY_RUN and DRY_RUN_MODE disagree; refusing live. Forcing dry-run.");
    }
    return true;
  }

  // Both explicitly false? Live.
  _dryRunValue = false;
  return false;
}

export function getMaxTradeSizeSol(): number {
  return parseFloat(env.MAX_TRADE_SIZE_SOL);
}

export function getMaxDeployedSol(): number {
  return parseFloat(env.MAX_DEPLOYED_SOL);
}

export function getMaxDailyLossSol(): number {
  return parseFloat(env.MAX_DAILY_LOSS_SOL);
}

export function getKillSwitch(): boolean {
  return env.KILL_SWITCH === "true" || env.KILL_SWITCH === "1";
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

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || env.RPC_URL;
}

export function getTakeProfitPct(): number {
  return parseFloat(env.TAKE_PROFIT_PCT);
}

export function getStopLossPct(): number {
  return parseFloat(env.STOP_LOSS_PCT);
}

export function getTrailingStopPct(): number {
  return parseFloat(env.TRAILING_STOP_PCT);
}

export function getStalePositionMinutes(): number {
  return parseInt(env.STALE_POSITION_MINUTES);
}

export function getExitAtrK(): number {
  return parseFloat(env.EXIT_ATR_K);
}

export function getPositionCheckIntervalMs(): number {
  return parseInt(env.POSITION_CHECK_INTERVAL_MS);
}

// --- Ingestion source flags (phase 6A) ---

function isTruthy(val: string | undefined): boolean {
  return val === "true" || val === "1";
}

export function ingestFlag(name: string): boolean {
  const map: Record<string, string | undefined> = {
    INGEST_DEXSCREENER_LATEST: env.INGEST_DEXSCREENER_LATEST,
    INGEST_DEXSCREENER_TRENDING: env.INGEST_DEXSCREENER_TRENDING,
    INGEST_DEXSCREENER_TRENDING_BULLISH: env.INGEST_DEXSCREENER_TRENDING_BULLISH,
    INGEST_BIRDEYE_TRENDING: env.INGEST_BIRDEYE_TRENDING,
    INGEST_BIRDEYE_NEW_LISTING: env.INGEST_BIRDEYE_NEW_LISTING,
    INGEST_BIRDEYE_TOP_TRADERS: env.INGEST_BIRDEYE_TOP_TRADERS,
    INGEST_PHANTOM: env.INGEST_PHANTOM,
  };
  return isTruthy(map[name]);
}

export function getDexscreenerTrendingPeriod(): "5m" | "1h" | "6h" | "24h" {
  const p = env.INGEST_DEXSCREENER_TRENDING_PERIOD;
  if (p === "5m" || p === "1h" || p === "6h" || p === "24h") return p;
  return "1h";
}

export function getDexscreenerChain(): string {
  return env.INGEST_DEXSCREENER_CHAIN;
}
