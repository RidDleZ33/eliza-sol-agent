export type CandleFeatures = {
  barCount: number;
  liveStartIdx: number | null;
  trimmed: boolean;
  sufficient: boolean;
  volatility: number | null;
  priceChange: number | null;
  volumeChange: number | null;
  sma5: number | null;
  sma20: number | null;
  rsi14: number | null;
  barInterval: "1m" | "5m";
};

export interface PAMetrics {
  currentPriceUsd: number;
  vwapUsd: number;
  vwapRatio: number; // e.g. 1.05 = +5% above VWAP
  buySellRatio5m: number; // e.g. 1.80 = 80% more buys than sells
  distanceFromPeakPct: number; // e.g. -18.5 = 18.5% pullback off peak
  emaTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  isOverextended?: boolean; // true if vwapRatio > threshold (PA_VWAP_DEFER_RATIO) OR distanceFromPeakPct > -2.0
  source?: 'dex' | 'birdeye' | 'gmgn'; // data source: dex (pair), birdeye (OHLCV), or gmgn (kline)
  features?: CandleFeatures | null; // derived from candles, observe-only
  interval?: "1m" | "5m" | null; // bar interval used, or null if Dex fallback
}