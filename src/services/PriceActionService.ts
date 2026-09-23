import { fetchWithRetry } from "../utils/circuitBreaker.ts";
import { logger } from "./LoggerService.ts";
import { getBirdeyeApiKey } from "../utils/env.ts";
import { PAMetrics, Candle } from "../types/priceAction.ts";

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

export class PriceActionService {
  private cache: Map<string, { metrics: PAMetrics; timestamp: number }> = new Map();
  private cacheTtlMs = 30000; // 30-second cache to reduce API load

  /**
   * Fetch and calculate PA metrics for a given Solana token mint.
   * Returns null if metrics cannot be calculated (new token, no volume, etc.)
   */
  async getPAMetrics(mintAddress: string): Promise<PAMetrics | null> {
    // Check cache
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.metrics;
    }

    try {
      // Step 1: Get current price via DexScreener
      const currentPrice = await this.getCurrentPrice(mintAddress);
      if (!currentPrice) {
        logger.warn("PA", "PriceAction", "Could not get current price", { mint: mintAddress });
        return null;
      }

      // Step 2: Get 5m candles from GeckoTerminal
      const candles5m = await this.fetchCandles(mintAddress, "5m");
      if (!candles5m || candles5m.length < 10) {
        logger.warn("PA", "PriceAction", "Insufficient 5m candle data", {
          mint: mintAddress,
          count: candles5m?.length || 0
        });
        return null;
      }

      // Step 3: Calculate VWAP from 1h of 5m candles (12 candles)
      const recentCandles = candles5m.slice(-12);
      const vwap = this.calculateVWAP(recentCandles);
      if (!vwap || vwap === 0) {
        logger.warn("PA", "PriceAction", "VWAP calculation failed", { mint: mintAddress });
        return null;
      }

      // Step 4: Calculate buy/sell ratio from 5m candle direction
      const buySellRatio = this.calculateBuySellRatio(candles5m.slice(-6));

      // Step 5: Calculate distance from recent peak (15m high = last 3 candles)
      const peakCandles = candles5m.slice(-3);
      const peakPrice = Math.max(...peakCandles.map(c => c.high));
      const distanceFromPeakPct = ((currentPrice - peakPrice) / peakPrice) * 100;

      // Step 6: Calculate EMA trend (9 vs 21 on 5m closes)
      const closes = candles5m.map(c => c.close);
      const emaTrend = this.determineEMATrend(closes);

      // Step 7: Determine if overextended
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
      };

      // Cache
      this.cache.set(mintAddress, { metrics, timestamp: Date.now() });

      return metrics;
    } catch (e: any) {
      logger.error("PA", "PriceAction", "Failed to calculate PA metrics", {
        mint: mintAddress,
        error: e.message
      });
      return null;
    }
  }

  private async getCurrentPrice(mint: string): Promise<number | null> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) return null;

      const data = await response.json();
      const pair = data?.pairs?.[0];
      if (pair && pair.priceUsd) {
        return parseFloat(pair.priceUsd);
      }
      return null;
    } catch (e: any) {
      logger.warn("PA", "PriceAction", "DexScreener price fetch failed", {
        mint,
        error: e.message
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
          status: response.status
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
        error: e.message
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

    if (sellVolume === 0) return 999; // Strong buy pressure, no sells
    return buyVolume / sellVolume;
  }

  private determineEMATrend(closes: number[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);

    if (!ema9 || !ema21) return "NEUTRAL";

    const spread = Math.abs((ema9 - ema21) / ema21);
    if (spread < 0.005) return "NEUTRAL"; // Within 0.5%

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
}

export const priceActionService = new PriceActionService();
export default priceActionService;
