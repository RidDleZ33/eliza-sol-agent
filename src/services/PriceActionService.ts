import { fetchWithRetry } from "../utils/circuitBreaker.ts";
import { logger } from "./LoggerService.ts";
import { PAMetrics, Candle } from "../types/priceAction.ts";
import { configService } from "./ConfigService.ts";

interface GeckoTerminalCandle {
  timestamp: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  volume_quote: number;
}

interface GeckoTerminalResponse {
  data: GeckoTerminalCandle[];
}

interface DexScreenerPair {
  chainId: string;
  baseToken: { address: string };
  quoteToken: { address: string };
  priceUsd: string;
  priceChange: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    m5: number;
    h1: number;
    h24: number;
  };
}

export class PriceActionService {
  private cache: Map<string, { metrics: PAMetrics; timestamp: number }> = new Map();
  private cacheTtlMs = 30000; // 30-second cache to reduce API load

  /**
   * Fetch and calculate PA metrics for a given Solana token mint.
   * Tries GeckoTerminal candles first, falls back to DexScreener pair data.
   * Returns null if metrics cannot be calculated.
   */
  async getPAMetrics(mintAddress: string): Promise<PAMetrics | null> {
    // Check cache
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.metrics;
    }

    try {
      // Step 1: Get 5m candles from GeckoTerminal
      const candles5m = await this.fetchCandles(mintAddress, "5m");

      if (candles5m && candles5m.length >= 10) {
        // GeckoTerminal path (original behavior)
        return this.buildGeckoMetrics(mintAddress, candles5m);
      }

      // Step 2: Fall back to DexScreener pair data
      logger.info("PA", "PriceAction", "Fallback to DexScreener pair data", {
        mint: mintAddress,
        candleCount: candles5m?.length || 0,
      });
      return this.buildDexMetrics(mintAddress);
    } catch (e: any) {
      logger.error("PA", "PriceAction", "Failed to calculate PA metrics", {
        mint: mintAddress,
        error: e.message,
      });
      return null;
    }
  }

  /**
   * Build PAMetrics from GeckoTerminal candle data (original path).
   */
  private buildGeckoMetrics(mint: string, candles5m: Candle[]): PAMetrics | null {
    const recentCandles = candles5m.slice(-12);
    const vwap = this.calculateVWAP(recentCandles);
    if (!vwap || vwap === 0) {
      logger.warn("PA", "PriceAction", "VWAP calculation failed", { mint });
      return null;
    }

    const currentPrice = candles5m[candles5m.length - 1].close;
    const buySellRatio = this.calculateBuySellRatio(candles5m.slice(-6));

    const peakCandles = candles5m.slice(-3);
    const peakPrice = Math.max(...peakCandles.map(c => c.high));
    const distanceFromPeakPct = ((currentPrice - peakPrice) / peakPrice) * 100;

    const closes = candles5m.map(c => c.close);
    const emaTrend = this.determineEMATrend(closes);

    const vwapRatio = currentPrice / vwap;
    const isOverextended = vwapRatio > 1.25 || distanceFromPeakPct > -2.0;

    const metrics: PAMetrics = {
      currentPriceUsd: currentPrice,
      vwapUsd: vwap,
      vwapRatio,
      buySellRatio5m: buySellRatio,
      distanceFromPeakPct,
      emaTrend,
      isOverextended,
      source: "gecko",
    };

    this.cache.set(mint, { metrics, timestamp: Date.now() });
    return metrics;
  }

  /**
   * Build PAMetrics from DexScreener pair data (fallback for young mints).
   */
  private async buildDexMetrics(mint: string): Promise<PAMetrics | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    try {
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        logger.warn("PA", "PriceAction", "DexScreener pair fetch failed", { mint, status: response.status });
        return null;
      }

      const data = await response.json();
      const pairs = data?.pairs;
      if (!pairs || pairs.length === 0) {
        logger.warn("PA", "PriceAction", "No DexScreener pairs found", { mint });
        return null;
      }

      // Prefer Solana chain pair
      const chainId = configService.getString("INGEST_DEXSCREENER_CHAIN") || "solana";
      const solPair = pairs.find((p: any) => p.chainId === chainId) || pairs[0];
      const pair = solPair as DexScreenerPair;

      const priceUsd = parseFloat(pair.priceUsd);
      if (!priceUsd || priceUsd <= 0) {
        logger.warn("PA", "PriceAction", "Invalid price from DexScreener", { mint });
        return null;
      }

      // Buy/sell ratio from txns.m5 (field is txns, not txs)
      const buys = pair.txns?.m5?.buys || 0;
      const sells = pair.txns?.m5?.sells || 0;
      const buySellRatio5m = sells > 0 ? buys / sells : 999;

      // Distance from peak: use priceChange.m5 as proxy (not a true peak, but best available)
      const priceChangeM5 = pair.priceChange?.m5;
      const distanceFromPeakPct = typeof priceChangeM5 === "number" ? priceChangeM5 : 0;

      // EMA trend: unknown on dex fallback
      const emaTrend: 'NEUTRAL' = "NEUTRAL";

      // Overextended: only if priceChange.m5 > 25%
      const isOverextended = typeof priceChangeM5 === "number" && priceChangeM5 > 25;

      const metrics: PAMetrics = {
        currentPriceUsd: priceUsd,
        vwapUsd: priceUsd, // synthetic, not a real VWAP
        vwapRatio: 1, // synthetic
        buySellRatio5m,
        distanceFromPeakPct,
        emaTrend,
        isOverextended,
        source: "dex",
      };

      this.cache.set(mint, { metrics, timestamp: Date.now() });

      logger.info("PA", "PriceAction", "PA fallback source=dex", {
        mint,
        buys,
        sells,
        chg5m: priceChangeM5,
      });

      return metrics;
    } catch (e: any) {
      logger.warn("PA", "PriceAction", "PA fallback dex fetch error", {
        mint,
        error: e.message,
      });
      return null;
    }
  }

  private async fetchCandles(
    mint: string,
    interval: "5m"
  ): Promise<Candle[] | null> {
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/market/candles?interval=${interval}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        logger.warn("PA", "PriceAction", "GeckoTerminal candles failed", {
          mint,
          status: response.status,
        });
        return null;
      }

      const data: GeckoTerminalResponse = await response.json();
      if (!data?.data) return null;

      return data.data.map(c => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: c.timestamp,
      }));
    } catch (e: any) {
      logger.warn("PA", "PriceAction", "GeckoTerminal candles error", {
        mint,
        error: e.message,
      });
      return null;
    }
  }

  private calculateVWAP(candles: Candle[]): number {
    let totalVolume = 0;
    let totalValue = 0;

    for (const c of candles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      totalValue += typicalPrice * c.volume;
      totalVolume += c.volume;
    }

    if (totalVolume === 0) return 0;
    return totalValue / totalVolume;
  }

  private calculateBuySellRatio(candles: Candle[]): number {
    let buyVolume = 0;
    let sellVolume = 0;

    for (const c of candles) {
      if (c.close >= c.open) {
        buyVolume += c.volume;
      } else {
        sellVolume += c.volume;
      }
    }

    if (sellVolume === 0) return 999;
    return buyVolume / sellVolume;
  }

  private determineEMATrend(closes: number[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);

    if (!ema9 || !ema21) return "NEUTRAL";

    const spread = Math.abs((ema9 - ema21) / ema21);
    if (spread < 0.005) return "NEUTRAL";

    return ema9 > ema21 ? "BULLISH" : "BEARISH";
  }

  private calculateEMA(prices: number[], period: number): number | null {
    if (prices.length < period) return null;

    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }

    return ema;
  }

  /**
   * Get 24h volatility using DexScreener priceChange fields.
   * Uses max of |h24|, |h6|, |h1| changes as a proxy for range.
   */
  async get24hHV(mint: string): Promise<number | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) return null;

      const data = await response.json();
      const pairs = data?.pairs;
      if (!pairs || pairs.length === 0) return null;

      const chainId = configService.getString("INGEST_DEXSCREENER_CHAIN") || "solana";
      const solPair = pairs.find((p: any) => p.chainId === chainId) || pairs[0];
      const pair = solPair as DexScreenerPair;

      // Use priceChange fields to estimate range (h24.high/low don't exist in API)
      const chg24 = Math.abs(pair.priceChange?.h24 ?? 0);
      const chg6 = Math.abs(pair.priceChange?.h6 ?? 0);
      const chg1 = Math.abs(pair.priceChange?.h1 ?? 0);
      const rangePct = Math.max(chg24, chg6, chg1);

      if (rangePct === 0) {
        logger.debug("PA", "PriceAction", "HV range is 0", { mint });
        return null;
      }

      const hv = rangePct / 100;
      logger.debug("PA", "PriceAction", "24h HV computed from priceChange", {
        mint,
        hv: hv.toFixed(4),
        chg24,
        chg6,
        chg1,
        hv_source: "dex_change",
      });

      return hv;
    } catch (e: any) {
      logger.warn("PA", "PriceAction", "24h HV fetch failed", {
        mint,
        error: e.message,
      });
      return null;
    }
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

export const priceActionService = new PriceActionService();
export default priceActionService;