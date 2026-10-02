// Pure candle feature helpers — deterministic, no I/O.
// Used by Gamma to derive observability features from OHLCV bars.
// No TA until N bars; refuse to emit metrics on dead prints.

export type OhlcvBar = {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

function barIsFinite(b: OhlcvBar): boolean {
  return (
    Number.isFinite(b.o) &&
    Number.isFinite(b.h) &&
    Number.isFinite(b.l) &&
    Number.isFinite(b.c) &&
    Number.isFinite(b.v)
  );
}

export function isFlatBar(b: OhlcvBar): boolean {
  if (!barIsFinite(b)) return true;
  return b.o === b.h && b.o === b.l && b.o === b.c;
}

// First index where there are three consecutive non-flat bars.
export function firstLiveIndex(bars: OhlcvBar[]): number | null {
  for (let i = 0; i <= bars.length - 3; i++) {
    if (!isFlatBar(bars[i]) && !isFlatBar(bars[i + 1]) && !isFlatBar(bars[i + 2])) {
      return i;
    }
  }
  return null;
}

export function deadTrim(bars: OhlcvBar[], lookback = 10): OhlcvBar[] {
  const live = firstLiveIndex(bars);
  if (live === null || live < lookback) return bars;
  return bars.slice(Math.max(0, live - lookback));
}

function simpleMovingAverage(bars: OhlcvBar[], period: number): number | null {
  if (bars.length < period) return null;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    sum += bars[i].c;
  }
  return sum / period;
}

/**
 * Standard EMA (Exponential Moving Average).
 * Seed = SMA of first `period` values, then k=2/(period+1).
 */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  // Seed with SMA
  let seedSum = 0;
  for (let i = 0; i < period; i++) {
    seedSum += values[i];
  }
  let emaVal = seedSum / period;
  const k = 2 / (period + 1);
  // Iterate through remaining values
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(bars: OhlcvBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const change = bars[i].c - bars[i - 1].c;
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// Last-bar feature metrics (on trimmed window)
function volatilityPct(bars: OhlcvBar[]): number | null {
  const last = bars[bars.length - 1];
  if (last.o === 0) return null;
  return (last.h - last.l) / last.o;
}

function priceChangePct(bars: OhlcvBar[]): number | null {
  const last = bars[bars.length - 1];
  if (last.o === 0) return null;
  return ((last.c - last.o) / last.o) * 100;
}

function volumeChangePct(bars: OhlcvBar[]): number | null {
  if (bars.length < 2) return null;
  const prev = bars[bars.length - 2];
  const last = bars[bars.length - 1];
  if (prev.v === 0) return null;
  return ((last.v - prev.v) / prev.v) * 100;
}

export type LastBarFeatures = {
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

export function lastBarFeatures(bars: OhlcvBar[], minBars = 20, interval: "1m" | "5m" = "1m"): LastBarFeatures | null {
  if (bars.length < 3) return null;

  const trimmedBars = deadTrim(bars);
  const trimmed = trimmedBars.length !== bars.length;
  const live = firstLiveIndex(bars);
  const sufficient = trimmedBars.length >= minBars;

  return {
    barCount: trimmedBars.length,
    liveStartIdx: live,
    trimmed,
    sufficient,
    volatility: volatilityPct(trimmedBars),
    priceChange: priceChangePct(trimmedBars),
    volumeChange: volumeChangePct(trimmedBars),
    sma5: simpleMovingAverage(trimmedBars, 5),
    sma20: simpleMovingAverage(trimmedBars, 20),
    rsi14: rsi(trimmedBars, 14),
    barInterval: interval,
  };
}