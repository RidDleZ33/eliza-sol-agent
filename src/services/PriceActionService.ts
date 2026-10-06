import { fetchWithRetry } from "../utils/circuitBreaker.ts";
import { logger } from "./LoggerService.ts";
import { PAMetrics, CandleFeatures } from "../types/priceAction.ts";

import { watchlistService } from "./WatchlistService.ts";
import { getPaBirdeyeOhlcv, getPaGmgnOhlcv, getBirdeyeApiKey, getDexscreenerChain, getPaBarAgeSplitMin, getPaNoBarsVetoPct, getPaMinBars, getPaVwapDeferRatio } from "../utils/env.ts";
import { lastBarFeatures, deadTrim, ema, OhlcvBar } from "./priceAction/candleFeatures.ts";
import { fetchBirdeyeOhlcv } from "./priceAction/birdeyeOhlcv.ts";
import { fetchGmgnOhlcv } from "./priceAction/gmgnOhlcv.ts";

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

  // Phase 12D: interval-aware caches; legacy names kept for HV path (always 1m)
  private barsCacheTtlMs = 90000;

  // 429 process-wide cooldown
  private rate429CooldownUntil: number = 0;
  private rate429CooldownMs = 60000;
  private rate429Logged = false;

  // Phase 12D: per-interval bars cache (mint + interval are separate cache entries)
  private barsCacheByInterval: Map<string, BarsCacheEntry> = new Map();
  private inflightByInterval: Map<string, Promise<BarsCacheEntry>> = new Map();

  // One-time skip reason logs
  private birdeyeOffLogged = false;
  private birdeyeNoKeyLogged = false;
  private gmgnOffLogged = false;

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
      if (cached.source === "birdeye" || cached.source === "gmgn" || !getPaBirdeyeOhlcv() || !getBirdeyeApiKey() || this.is429Cooldown()) {
        return cached.metrics;
      }
      // Otherwise try fresh birdeye fetch
    }

    try {
      // Step 2: Try GMGN kline (if enabled) — no API key, saves Birdeye CU
      let barsEntry: BarsCacheEntry | null = null;
      if (getPaGmgnOhlcv()) {
        const interval = this.chooseInterval(mintAddress);
        const countLimit = interval === "1m" ? 60 : 48;
        barsEntry = await this.getGmgnBars(mintAddress, interval, countLimit);
        if (barsEntry.bars && barsEntry.bars.length >= 3) {
          const trimmed = deadTrim(barsEntry.bars);
          const features = lastBarFeatures(trimmed, getPaMinBars(), interval);
          const dexPair = this.getDexPairForBuySell(mintAddress);
          const metrics = metricsFromBars(trimmed, features, dexPair, interval);
          if (metrics) {
            this.cache.set(mintAddress, { metrics, timestamp: Date.now(), source: "gmgn" });
            logger.info("PA source=gmgn", {
              mint: mintAddress,
              bars: barsEntry.bars.length,
              trimmed: trimmed.length,
              interval,
            });
            return metrics;
          }
        }
        logger.info("PA gmgn skip", {
          mint: mintAddress,
          reason: barsEntry.reason,
          bars: barsEntry.bars?.length ?? 0,
          interval,
        });
      } else if (!this.gmgnOffLogged) {
        logger.info("PA gmgn off");
        this.gmgnOffLogged = true;
      }

      // Step 3: Try Birdeye OHLCV (if enabled + key + no cooldown)
      if (!getPaBirdeyeOhlcv()) {
        if (!this.birdeyeOffLogged) {
          logger.info("PA birdeye off");
          this.birdeyeOffLogged = true;
        }
      } else if (!getBirdeyeApiKey()) {
        if (!this.birdeyeNoKeyLogged) {
          logger.info("PA birdeye nokey");
          this.birdeyeNoKeyLogged = true;
        }
      } else if (this.is429Cooldown()) {
        // Already logged by set429Cooldown
      } else {
        // Phase 12D: choose interval by pair age
        const interval = this.chooseInterval(mintAddress);
        const countLimit = interval === "1m" ? 60 : 48;
        const barsEntry = await this.getBirdeyeBars(mintAddress, interval, countLimit);
        if (barsEntry.bars && barsEntry.bars.length >= 3) {
          // Trim once; pass same trimmed array to both features and metrics
          const trimmed = deadTrim(barsEntry.bars);
          const features = lastBarFeatures(trimmed, getPaMinBars(), interval);
          const dexPair = this.getDexPairForBuySell(mintAddress);
          const metrics = metricsFromBars(trimmed, features, dexPair, interval);
          if (metrics) {
            this.cache.set(mintAddress, { metrics, timestamp: Date.now(), source: "birdeye" });
            logger.info("PA source=birdeye", {
              mint: mintAddress,
              bars: barsEntry.bars.length,
              trimmed: trimmed.length,
              interval,
              "cu~12": true,
            });
            return metrics;
          }
        }
        // Birdeye attempted but not used — log skip reason
        const reason = barsEntry.reason;
        const barsCount = barsEntry.bars?.length ?? 0;
        logger.info("PA birdeye skip", {
          mint: mintAddress,
          reason,
          bars: barsCount,
          interval,
        });
      }

      // Step 4: Dex stashed pair (if fresh)
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

      // Step 5: Live Dex GET
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
      const chainId = getDexscreenerChain();
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
   * Phase 12D: choose bar interval by pair age.
   * Under the age split → 1m bars; at/over → 5m bars.
   */
  private chooseInterval(mintAddress: string): "1m" | "5m" {
    // Policy: if age missing, treat as old → 5m bars
    const ageMin = this.pairAgeMinutes(mintAddress);
    if (ageMin !== null && ageMin < getPaBarAgeSplitMin()) {
      return "1m";
    }
    return "5m";
  }

  /**
   * Pair age in minutes from stashed Dex pair pairCreatedAt.
   * Null if unknown (treated as old → 5m bars).
   */
  private pairAgeMinutes(mintAddress: string): number | null {
    const stashed = watchlistService.getDexPair(mintAddress);
    if (!stashed || !stashed.pair.pairCreatedAt) {
      return null;
    }
    return (Date.now() - stashed.pair.pairCreatedAt) / 60000;
  }

  /**
   * Get or fetch Birdeye bars for a mint at a given interval with interval-keyed cache.
   */
  private async getBirdeyeBars(
    mintAddress: string,
    interval: "1m" | "5m",
    countLimit: number
  ): Promise<BarsCacheEntry> {
    const cacheKey = `${mintAddress}:${interval}`;

    // Check interval-keyed bars cache
    const cached = this.barsCacheByInterval.get(cacheKey);
    if (cached && Date.now() - cached.atMs < this.barsCacheTtlMs) {
      return cached;
    }

    // Single-flight: if in-flight, wait for it
    const existing = this.inflightByInterval.get(cacheKey);
    if (existing) {
      return existing;
    }

    const apiKey = getBirdeyeApiKey()!;
    const promise = (async () => {
      try {
        const result = await fetchBirdeyeOhlcv(mintAddress, apiKey, interval, countLimit);

        if (result.reason === "rate_429") {
          this.set429Cooldown();
        }

        return { bars: result.bars, atMs: Date.now(), reason: result.reason };
      } finally {
        this.inflightByInterval.delete(cacheKey);
      }
    })();

    this.inflightByInterval.set(cacheKey, promise);
    const entry = await promise;

    // Cache result by interval key
    this.barsCacheByInterval.set(cacheKey, entry);
    return entry;
  }

  /**
   * Get or fetch GMGN kline bars for a mint at a given interval with interval-keyed cache.
   */
  private async getGmgnBars(
    mintAddress: string,
    interval: "1m" | "5m",
    countLimit: number
  ): Promise<BarsCacheEntry> {
    // Separate cache key so GMGN miss doesn't shadow Birdeye
    const cacheKey = `gmgn:${mintAddress}:${interval}`;

    // Check interval-keyed bars cache
    const cached = this.barsCacheByInterval.get(cacheKey);
    if (cached && Date.now() - cached.atMs < this.barsCacheTtlMs) {
      return cached;
    }

    // Single-flight: if in-flight, wait for it
    const existing = this.inflightByInterval.get(cacheKey);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const result = await fetchGmgnOhlcv(mintAddress, interval, countLimit);
        return { bars: result.bars, atMs: Date.now(), reason: result.reason };
      } finally {
        this.inflightByInterval.delete(cacheKey);
      }
    })();

    this.inflightByInterval.set(cacheKey, promise);
    const entry = await promise;

    // Cache result by interval key
    this.barsCacheByInterval.set(cacheKey, entry);
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
      // HV path: use 1m bars if cached (cheaper, higher-res for volatility)
      const cached = this.barsCacheByInterval.get(`${mint}:1m`);
      if (cached && cached.bars && Date.now() - cached.atMs < this.barsCacheTtlMs) {
        const trimmed = deadTrim(cached.bars);
        if (trimmed.length >= 20) {
          const hv = this.computeHVFromBars(trimmed);
          if (hv !== null) return hv;
        }
      }
      // Fallback to 5m bars if 1m miss or insufficient
      const cached5m = this.barsCacheByInterval.get(`${mint}:5m`);
      if (cached5m && cached5m.bars && Date.now() - cached5m.atMs < this.barsCacheTtlMs) {
        const trimmed = deadTrim(cached5m.bars);
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

      const chainId = getDexscreenerChain();
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
  dexPair: DexPair | null,
  interval: "1m" | "5m" = "1m"
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

  // Overextended: vwapRatio exceeds threshold (disabled if threshold <= 0) or within 2% of peak
  const vwapThreshold = getPaVwapDeferRatio();
  const isOverextended = (vwapThreshold > 0 && vwapRatio > vwapThreshold) || distanceFromPeakPct > -2;

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
    interval,
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
    interval: null,
  };
}

export const priceActionService = new PriceActionService();
export default priceActionService;
