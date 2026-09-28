import { fetchWithRetry } from "../../utils/circuitBreaker.ts";
import { logger } from "../LoggerService.ts";

/**
 * Shared DexScreener pair board fetchers and mappers.
 * Used by both the latest-launch and trending pair watchers.
 */

export interface DiscoveredToken {
  address: string;
  symbol: string;
  volume24h: number;
  liquidityUsd: number;
}

/**
 * Fetch JSON from a DexScreener board URL.
 * Throws with status and body snippet on non-OK responses.
 */
export async function fetchDexJson(url: string): Promise<unknown> {
  logger.debug("INGESTION", "dexscreenerPairs", `Fetching: ${url}`);
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    const bodyPrefix = (await res.text()).slice(0, 120);
    throw new Error(`DexScreener ${res.status} for ${url}: ${bodyPrefix}`);
  }
  return res.json();
}

/**
 * Accept raw array, { pairs: [] }, or { tokens: [] } payloads and normalize to array.
 */
export function pairsFromUnknown(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.pairs)) return obj.pairs;
    if (Array.isArray(obj.tokens)) return obj.tokens;
  }
  return [];
}

/**
 * Map a DexScreener pair object to a discovered token.
 * Volume: pair.volume.h24 is a number (not volume.h24.usd).
 * Drops mints shorter than 32 chars.
 */
export function toDiscovered(pair: any, chainId: string): DiscoveredToken | null {
  if (pair.chainId && pair.chainId !== chainId) return null;

  const mint = pair.baseToken?.address || pair.tokenAddress || pair.address;
  if (!mint || typeof mint !== "string" || mint.length < 32) return null;

  const symbol = pair.baseToken?.symbol || pair.symbol || "UNKNOWN";

  // pair.volume.h24 is a number, not an object with .usd
  const volume = Number(
    pair.volume?.h24 ?? pair.volume?.h24?.usd ?? pair.volume24h ?? pair.volume?.usd ?? 0
  );

  const liq = Number(pair.liquidity?.usd ?? pair.liquidity ?? 0);

  return { address: mint, symbol, volume24h: volume, liquidityUsd: liq };
}
