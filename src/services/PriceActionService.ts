import { fetchWithRetry } from "../utils/circuitBreaker.ts";
import { logger } from "./LoggerService.ts";
import { PAMetrics, CandleFeatures } from "../types/priceAction.ts";
import { configService } from "./ConfigService.ts";
import { watchlistService } from "./WatchlistService.ts";
import { getPaBirdeyeOhlcv, getBirdeyeApiKey } from "../utils/env.ts";
import { lastBarFeatures, deadTrim, ema, OhlcvBar } from "./priceAction/candleFeatures.ts";
import { fetchBirdeyeOhlcv } from "./priceAction/birdeyeOhlcv.ts";

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

type BarsCacheEntry = {
  bars: OhlcvBar[] | null;
  atMs: number;
  reason: string;
};

export class PriceActionService {
  private cache: Map<string, { metrics: PAMetrics; timestamp: number; source: string }> = new Map();
  private cacheTtlMs = 30000; // 30-second cache for metrics

  // Birdeye OHLCV per-mint cache (90s TTL)
  private barsCache: Map<string, BarsCacheEntry> = new Map();
  private barsCacheTtlMs = 90000;

  // Single-flight: in-flight fetches per mint
  private inflight: Map<string, Promise<BarsCacheEntry>> = new Map();

  // 429 process-wide cooldown
  private rate429CooldownUntil: number = 0;
  private rate429CooldownMs = 60000;
  private rate429Logged = false;

  // Last raw Dex body per mint (for 24h HV reuse)
  private lastDexBody: Map<string, { body: DexPair; timestamp: number }> = new Map();

  /**
   * Fetch and calculate PA metrics for a given Solana token mint.
   * Order: cache → (Birdeye OHLCV if on) → Dex pair → null.
   * Returns null if metrics cannot be calculated.
   */
  async getPAMetrics(mintAddress: string): Promise<PAMetrics | null> {
    // Step 1: Check memory cache
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      // If cached from birdeye, or birdeye is off/cooldown, return it
      if (cached.source === "birdeye" || !getPaBirdeyeOhlcv() || !getBirdeyeApiKey() || this.is429Cooldown()) {
        return cached.metrics;
      }
      // Otherwise try fresh birdeye fetch
    }

    try {
      // Step 2: Try Birdeye OHLCV (if enabled + key + no cooldown)
      if (getPaBirdeyeOhlcv() && getBirdeyeApiKey() && !this.is429Cooldown()) {
        const barsEntry = await this.getBirdeyeBars(mintAddress);
        if (barsEntry.bars && barsEntry.bars.length >= 3) {
          // lastBarFeatures dead-trims internally; don't double-trim
          const features = lastBarFeatures(barsEntry.bars);
          const dexPair = this.getDexPairForBuySell(mintAddress);
          const metrics = metricsFromBars(barsEntry.bars, features, dexPair);
          if (metrics) {
            this.cache.set(mintAddress, { metrics, timestamp: Date.now(), source: "birdeye" });
            logger.info("PA source=birdeye", {
              mint: mintAddress,
              bars: barsEntry.bars.length,
              trimmed: features?.barCount ?? 0,
              "cu~12": true,
            });
            return metrics;
          }
        }
      }

      // Step 3: Dex stashed pair (if fresh)
      const stashed = watchlistService.getDexPair(mintAddress);
      if (stashed && stashed.at && Date.now() - stashed.at < 120000) {
        try {
          const metrics = mapDexPairToMetrics(stashed.pair);
          if (metrics) {
            this.cache.set(mintAddress, { metrics, timestamp: Date.now(), source: "dex" });
            this.lastDexBody.set(mintAddress, {
              body: stashed.pair,
              timestamp: Date.now(),
            });
            logger.debug("PA source=dex_stash", { mint: mintAddress });
            return metrics;
          }
        } catch (e: any) {
          logger.debug("PA bad stash", { mint: mintAddress, error: e.message });
        }
      }

      // Step 4: Live Dex GET
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
        logger.debug("PA stash fail", { mint: mintAddress, error: e.message });
      }

      const metrics = mapDexPairToMetrics(pair);
      if (metrics) {
        this.cache.set(mintAddress, { metrics, timestamp: Date.now(), source: "dex" });
        logger.info("PA source=dex", {
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
   * Get or fetch Birdeye bars for a mint with caching and single-flight.
   */
  private async getBirdeyeBars(mintAddress: string): Promise<BarsCacheEntry> {
    // Check bars cache
    const cached = this.barsCache.get(mintAddress);
    if (cached && Date.now() - cached.atMs < this.barsCacheTtlMs) {
      return cached;
    }

    // Single-flight: if in-flight, wait for it
    const existing = this.inflight.get(mintAddress);
    if (existing) {
      return existing;
    }

    const apiKey = getBirdeyeApiKey()!;
    const promise = (async () => {
      try {
        const result = await fetchBirdeyeOhlcv(mintAddress, apiKey);

        if (result.reason === "rate_429") {
          this.set429Cooldown();
        }

        return { bars: result.bars, atMs: Date.now(), reason: result.reason };
      } finally {
        this.inflight.delete(mintAddress);
      }
    })();

    this.inflight.set(mintAddress, promise);
    const entry = await promise;

    // Cache result
    this.barsCache.set(mintAddress, entry);
    return entry;
  }

  private is429Cooldown(): boolean {
    if (Date.now() >= this.rate429CooldownUntil) {
      this.rate429Logged = false;
      return false;
    }
    return true;
  }

  private set429Cooldown() {
    this.rate429CooldownUntil = Date.now() + this.rate429CooldownMs;
    if (!this.rate429Logged) {
      logger.info("PA birdeye 429 cooldown", { seconds: this.rate429CooldownMs / 1000 });
      this.rate429Logged = true;
    }
  }

  /**
   * Get Dex pair for buy/sell ratio (separate from OHLCV metrics).
   */
  private getDexPairForBuySell(mintAddress: string): DexPair | null {
    const stashed = watchlistService.getDexPair(mintAddress);
    if (stashed && stashed.at && Date.now() - stashed.at < 120000) {
      return stashed.pair;
    }
    return null;
  }

  /**
   * Get 24h volatility using last cached Dex body or fresh GET.
   * If Birdeye bars are fresh and sufficient, compute HV from them instead.
   */
  async get24hHV(mint: string): Promise<number | null> {
    // Try Birdeye bars first if fresh
    if (getPaBirdeyeOhlcv() && getBirdeyeApiKey() && !this.is429Cooldown()) {
      const cached = this.barsCache.get(mint);
      if (cached && cached.bars && Date.now() - cached.atMs < this.barsCacheTtlMs) {
        const trimmed = deadTrim(cached.bars);
        if (trimmed.length >= 20) {
          const hv = this.computeHVFromBars(trimmed);
          if (hv !== null) return hv;
        }
      }
    }

    try {
      // Try last cached Dex body first (avoids second GET)
      const dexCached = this.lastDexBody.get(mint);
      if (dexCached && Date.now() - dexCached.timestamp < 60000) {
        return this.computeHVFromPair(dexCached.body);
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
      logger.warn(`PA hv miss mint=${mint} reason=${e.message}`);
      return null;
    }
  }

  /**
   * Compute HV from OHLCV bars: (max(high)-min(low))/mean(close).
   */
  private computeHVFromBars(bars: OhlcvBar[]): number | null {
    if (bars.length < 2) return null;

    let maxHigh = -Infinity;
    let minLow = Infinity;
    let sumClose = 0;

    for (const bar of bars) {
      if (!Number.isFinite(bar.h) || !Number.isFinite(bar.l) || !Number.isFinite(bar.c)) {
        continue;
      }
      if (bar.h > maxHigh) maxHigh = bar.h;
      if (bar.l < minLow) minLow = bar.l;
      sumClose += bar.c;
    }

    if (!Number.isFinite(maxHigh) || !Number.isFinite(minLow) || sumClose === 0) {
      return null;
    }

    const meanClose = sumClose / bars.length;
    if (meanClose === 0) return null;

    return (maxHigh - minLow) / meanClose;
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
 * Compute PAMetrics from OHLCV bars + last-bar features + optional Dex pair for buy/sell.
 * Pure function — no network, no DB.
 */
export function metricsFromBars(
  bars: OhlcvBar[],
  features: CandleFeatures | null,
  dexPair: DexPair | null
): PAMetrics | null {
  if (bars.length === 0) return null;

  const lastBar = bars[bars.length - 1];
  if (!Number.isFinite(lastBar.c) || lastBar.c <= 0) return null;

  const currentPriceUsd = lastBar.c;

  // VWAP = sum(c*v)/sum(v) on trimmed bars with v>0
  let sumCV = 0;
  let sumV = 0;
  for (const bar of bars) {
    if (bar.v > 0 && Number.isFinite(bar.c) && Number.isFinite(bar.v)) {
      sumCV += bar.c * bar.v;
      sumV += bar.v;
    }
  }
  const vwapUsd = sumV > 0 ? sumCV / sumV : currentPriceUsd;
  const vwapRatio = vwapUsd > 0 ? currentPriceUsd / vwapUsd : 1;

  // Distance from peak: use max(high) from bars
  let maxHigh = 0;
  for (const bar of bars) {
    if (Number.isFinite(bar.h) && bar.h > maxHigh) {
      maxHigh = bar.h;
    }
  }
  const distanceFromPeakPct = maxHigh > 0 ? ((currentPriceUsd / maxHigh) - 1) * 100 : 0;

  // EMA trend: real EMA9 vs EMA21 (need ≥21 closes)
  let emaTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c));
  if (closes.length >= 21) {
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    if (ema9 !== null && ema21 !== null) {
      if (ema9 > ema21 * 1.001) {
        emaTrend = "BULLISH";
      } else if (ema9 < ema21 * 0.999) {
        emaTrend = "BEARISH";
      }
    }
  }

  // Overextended: vwapRatio > 1.25 or within 2% of peak
  const isOverextended = vwapRatio > 1.25 || distanceFromPeakPct > -2;

  // Buy/sell ratio: use Dex pair if available, else 1 (unknown)
  let buySellRatio5m = 1;
  if (dexPair) {
    const buys = dexPair.txns?.m5?.buys ?? 0;
    const sells = dexPair.txns?.m5?.sells ?? 0;
    buySellRatio5m = sells > 0 ? buys / sells : 999;
  }

  return {
    currentPriceUsd,
    vwapUsd,
    vwapRatio,
    buySellRatio5m,
    distanceFromPeakPct,
    emaTrend,
    isOverextended,
    source: "birdeye",
    features,
  };
}

/**
 * Map a DexScreener pair object to PAMetrics (fallback when Birdeye is off).
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

  // Distance from peak: use priceChange.m5 as proxy
  const priceChangeM5 = pair.priceChange?.m5 ?? 0;

  // EMA trend: unknown on dex fallback
  const emaTrend: "NEUTRAL" = "NEUTRAL";

  // Overextended: only if priceChange.m5 > 25%
  const isOverextended = typeof priceChangeM5 === "number" && priceChangeM5 > 25;

  return {
    currentPriceUsd: priceUsd,
    vwapUsd: priceUsd, // synthetic
    vwapRatio: 1, // synthetic
    buySellRatio5m,
    distanceFromPeakPct: priceChangeM5,
    emaTrend,
    isOverextended,
    source: "dex",
    features: null,
  };
}

export const priceActionService = new PriceActionService();
export default priceActionService;
