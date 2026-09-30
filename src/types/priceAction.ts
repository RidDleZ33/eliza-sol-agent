export interface PAMetrics {
  currentPriceUsd: number;
  vwapUsd: number;
  vwapRatio: number; // e.g. 1.05 = +5% above VWAP
  buySellRatio5m: number; // e.g. 1.80 = 80% more buys than sells
  distanceFromPeakPct: number; // e.g. -18.5 = 18.5% pullback off peak
  emaTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  isOverextended?: boolean; // true if vwapRatio > 1.25 OR distanceFromPeakPct > -2.0
  source?: 'dex' | 'birdeye'; // data source: dex (pair) or birdeye (OHLCV, optional)
}