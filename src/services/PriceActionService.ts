import { fetchWithRetry } from "../utils/circuitBreaker.ts";
import { logger } from "./LoggerService.ts";
import { PAMetrics } from "../types/priceAction.ts";
import { configService } from "./ConfigService.ts";
import { watchlistService } from "./WatchlistService.ts";
import { getPaBirdeyeOhlcv, getBirdeyeApiKey } from "../utils/env.ts";
import { lastBarFeatures, OhlcvBar } from "./priceAction/candleFeatures.ts";

// DexScreener pair shape (subset used by PA)
interface DexPair {
  chainId: string;
  pairAddress?: string;
  dexId?: string;
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string };
  priceUsd?: string;
  priceChange?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h24?: number;
  };
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

export class PriceActionService {
  private cache: Map<string, { metrics: PAMetrics; timestamp: number }> = new Map();
  private cacheTtlMs = 30000; // 30-second cache to reduce API load
  // Last raw Dex body per mint (for 24h HV reuse, avoids second GET)
  private lastDexBody: Map<string, { body: DexPair; timestamp: number }> = new Map();

  /**
   * Fetch and calculate PA metrics for a given Solana token mint.
   * Order: cache → stashed Dex pair → live Dex GET → optional Birdeye OHLCV.
   * Returns null if metrics cannot be calculated.
   */
  async getPAMetrics(mintAddress: string): Promise<PAMetrics | null> {
    // Step 1: Check memory cache
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.metrics;
    }

    // Phase 11A3N: Birdeye OHLCV is opt-in, default off
    if (!getPaBirdeyeOhlcv() || !getBirdeyeApiKey()) {
      logger.debug("PA birdeye skipped");
    }

    try {
      // Step 2: Stashed Dex pair from ingest (if fresh)
      const stashed = watchlistService.getDexPair(mintAddress);
      if (stashed && stashed.at && Date.now() - stashed.at < 120000) {
        try {
          const metrics = mapDexPairToMetrics(stashed.pair);
          if (metrics) {
            this.cache.set(mintAddress, { metrics, timestamp: Date.now() });
            this.lastDexBody.set(mintAddress, {
              body: stashed.pair,
              timestamp: Date.now(),
            });
            logger.debug("PA", "PriceAction", "PA from stashed pair", { mint: mintAddress });
            return metrics;
          }
        } catch (e: any) {
          logger.debug("PA", "PriceAction", "Bad stashed pair", { mint: mintAddress, error: e.message });
        }
      }

      // Step 3: Live Dex GET
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        logger.warn(`PA miss mint=${mintAddress} reason=http_${response.status}`);
        return null;
      }

      const data = await response.json();
      const pairs = data?.pairs;
      if (!pairs || pairs.length === 0) {
        logger.warn(`PA miss mint=${mintAddress} reason=no_pair`);
        return null;
      }

      // Prefer Solana chain pair
      const chainId = configService.getString("INGEST_DEXSCREENER_CHAIN") || "solana";
      const solPair = pairs.find((p: any) => p.chainId === chainId) || pairs[0];
      const pair = solPair as DexPair;

      // Cache raw body for HV reuse
      this.lastDexBody.set(mintAddress, { body: pair, timestamp: Date.now() });

      // Slim it and stash for next tick
      try {
        watchlistService.saveDexPair(mintAddress, pair);
      } catch (e: any) {
        logger.debug("PA", "PriceAction", "Failed to stash pair", { mint: mintAddress, error: e.message });
      }

      const metrics = mapDexPairToMetrics(pair);
      if (metrics) {
        this.cache.set(mintAddress, { metrics, timestamp: Date.now() });
        logger.info("PA", "PriceAction", "PA source=dex", {
          mint: mintAddress,
          buys: pair.txns?.m5?.buys,
          sells: pair.txns?.m5?.sells,
          chg5m: pair.priceChange?.m5,
        });
        return metrics;
      }

      logger.warn(`PA miss mint=${mintAddress} reason=map_failed`);
      return null;
    } catch (e: any) {
      logger.warn(`PA miss mint=${mintAddress} reason=${e.message}`);
      return null;
    }
  }

  /**
   * Get 24h volatility using last cached Dex body or fresh GET.
   * Reuses the body from getPAMetrics if available to avoid second request.
   */
  async get24hHV(mint: string): Promise<number | null> {
    try {
      // Try last cached body first (avoids second GET)
      const cached = this.lastDexBody.get(mint);
      if (cached && Date.now() - cached.timestamp < 60000) {
        return this.computeHVFromPair(cached.body);
      }

      // Stashed pair
      const stashed = watchlistService.getDexPair(mint);
      if (stashed && stashed.at && Date.now() - stashed.at < 120000) {
        const hv = this.computeHVFromPair(stashed.pair);
        if (hv !== null) return hv;
      }

      // Fresh GET
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) return null;

      const data = await response.json();
      const pairs = data?.pairs;
      if (!pairs || pairs.length === 0) return null;

      const chainId = configService.getString("INGEST_DEXSCREENER_CHAIN") || "solana";
      const solPair = pairs.find((p: any) => p.chainId === chainId) || pairs[0];
      const pair = solPair as DexPair;

      return this.computeHVFromPair(pair);
    } catch (e: any) {
      logger.warn(`PA miss mint=${mint} reason=hv_${e.message}`);
      return null;
    }
  }

  private computeHVFromPair(pair: DexPair): number | null {
    const chg24 = Math.abs(pair.priceChange?.h24 ?? 0);
    const chg6 = Math.abs(pair.priceChange?.h6 ?? 0);
    const chg1 = Math.abs(pair.priceChange?.h1 ?? 0);
    const rangePct = Math.max(chg24, chg6, chg1);

    if (rangePct === 0) {
      return null;
    }

    return rangePct / 100;
  }

  /**
   * Label market regime based on 24h HV.
   */
  labelRegime(hv: number): "CHOP" | "TREND" | "SHOCK" {
    if (hv < 0.40) return "CHOP";
    if (hv <= 0.80) return "TREND";
    return "SHOCK";
  }
}

/**
 * Map a DexScreener pair object to PAMetrics.
 * Pure function — no network, no DB.
 */
export function mapDexPairToMetrics(pair: DexPair): PAMetrics | null {
  const priceUsd = parseFloat(pair.priceUsd ?? "0");
  if (!priceUsd || priceUsd <= 0) {
    return null;
  }

  // Buy/sell ratio from txns.m5 (field is txns, not txs)
  const buys = pair.txns?.m5?.buys ?? 0;
  const sells = pair.txns?.m5?.sells ?? 0;
  const buySellRatio5m = sells > 0 ? buys / sells : 999;

  // Distance from peak: use priceChange.m5 as proxy (not a true peak, but best available)
  const priceChangeM5 = pair.priceChange?.m5 ?? 0;

  // EMA trend: unknown on dex fallback
  const emaTrend: "NEUTRAL" = "NEUTRAL";

  // Overextended: only if priceChange.m5 > 25%
  const isOverextended = typeof priceChangeM5 === "number" && priceChangeM5 > 25;

  return {
    currentPriceUsd: priceUsd,
    vwapUsd: priceUsd, // synthetic, not a real VWAP
    vwapRatio: 1, // synthetic
    buySellRatio5m,
    distanceFromPeakPct: priceChangeM5,
    emaTrend,
    isOverextended,
    source: "dex",
  };
}

/**
 * Phase 11B: derive candle features from OHLCV bars (observe-only).
 * Returns null if bars are missing or insufficient.
 */
export function deriveCandleFeatures(bars: OhlcvBar[]): PAMetrics["features"] {
  return lastBarFeatures(bars);
}

export const priceActionService = new PriceActionService();
export default priceActionService;