import { describe, test, expect } from "bun:test";
import {
  OhlcvBar,
  isFlatBar,
  firstLiveIndex,
  deadTrim,
  lastBarFeatures,
} from "../src/services/priceAction/candleFeatures.ts";

function makeBar(t: number, o: number, h: number, l: number, c: number, v: number): OhlcvBar {
  return { t, o, h, l, c, v };
}

function makeLiveBars(n: number, startPrice = 100, startVol = 1000): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    price = price * 1.001;
    const spread = price * 0.01;
    bars.push(makeBar(i * 60000, price - spread, price + spread * 0.5, price - spread * 0.5, price, startVol * (1 + i * 0.01)));
  }
  return bars;
}

function makeFlatBars(n: number, price = 100): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(makeBar(i * 60000, price, price, price, price, 0));
  }
  return bars;
}

describe("isFlatBar", () => {
  test("true when o=h=l=c", () => {
    expect(isFlatBar(makeBar(0, 100, 100, 100, 100, 10))).toBe(true);
  });

  test("false when h > l", () => {
    expect(isFlatBar(makeBar(0, 100, 105, 98, 102, 10))).toBe(false);
  });

  test("true on non-finite values", () => {
    expect(isFlatBar({ t: 0, o: NaN, h: 100, l: 100, c: 100, v: 10 })).toBe(true);
  });
});

describe("firstLiveIndex", () => {
  test("null when all bars are flat", () => {
    expect(firstLiveIndex(makeFlatBars(10))).toBe(null);
  });

  test("null when fewer than 3 consecutive live bars", () => {
    const bars = makeFlatBars(5);
    bars[2] = makeBar(2 * 60000, 100, 101, 99, 100.5, 50);
    expect(firstLiveIndex(bars)).toBe(null);
  });

  test("returns index of first live triple", () => {
    const bars = makeFlatBars(5);
    for (let i = 3; i < 6; i++) {
      bars[i] = makeBar(i * 60000, 100, 101, 99, 100.5, 50);
    }
    expect(firstLiveIndex(bars)).toBe(3);
  });
});

describe("deadTrim", () => {
  test("returns same array when all flat", () => {
    const bars = makeFlatBars(10);
    expect(deadTrim(bars).length).toBe(10);
  });

  test("trims to 10 bars before first live triple", () => {
    const bars = makeFlatBars(25);
    for (let i = 15; i < 18; i++) {
      bars[i] = makeBar(i * 60000, 100, 101, 99, 100.5, 50);
    }
    const trimmed = deadTrim(bars, 10);
    expect(trimmed.length).toBe(20); // slice(5) = 25-5 = 20 bars (10 before live start at 15)
  });

  test("does not trim when live start is within lookback", () => {
    const bars = makeFlatBars(5);
    for (let i = 3; i < 6; i++) {
      bars[i] = makeBar(i * 60000, 100, 101, 99, 100.5, 50);
    }
    expect(deadTrim(bars, 10).length).toBe(6);
  });
});

describe("lastBarFeatures", () => {
  test("null when fewer than 3 bars", () => {
    expect(lastBarFeatures(makeLiveBars(2))).toBe(null);
  });

  test("insufficient when fewer than 20 bars", () => {
    const features = lastBarFeatures(makeLiveBars(10));
    expect(features).not.toBeNull();
    expect(features!.sufficient).toBe(false);
    expect(features!.sma20).toBe(null);
  });

  test("sufficient with 20+ bars", () => {
    const features = lastBarFeatures(makeLiveBars(25));
    expect(features!.sufficient).toBe(true);
    expect(features!.sma20).not.toBeNull();
    expect(features!.rsi14).not.toBeNull();
  });

  test("sma20 equals mean of last 20 closes", () => {
    const bars = makeLiveBars(25);
    const features = lastBarFeatures(bars);
    let sum = 0;
    for (let i = 5; i < 25; i++) {
      sum += bars[i].c;
    }
    const expectedSma = sum / 20;
    expect(features!.sma20).toBeCloseTo(expectedSma, 10);
  });

  test("rsi is finite and in [0, 100]", () => {
    const features = lastBarFeatures(makeLiveBars(25));
    expect(features!.rsi14).not.toBeNull();
    expect(features!.rsi14).toBeGreaterThanOrEqual(0);
    expect(features!.rsi14).toBeLessThanOrEqual(100);
  });

  test("price change is null when last bar open is 0", () => {
    const bars = [
      makeBar(0, 100, 101, 99, 100.5, 50),
      makeBar(1, 100.5, 102, 99, 101, 55),
      makeBar(2, 0, 10, 5, 8, 60),
    ];
    const features = lastBarFeatures(bars);
    expect(features!.priceChange).toBe(null);
  });

  test("volatility is last bar's range/open", () => {
    const bars = [
      makeBar(0, 100, 101, 99, 100.5, 50),
      makeBar(1, 100.5, 102, 99, 101, 55),
      makeBar(2, 101, 103, 99, 101.5, 60),
    ];
    const features = lastBarFeatures(bars);
    expect(features!.volatility).toBeCloseTo(0.04); // (103-99)/101
  });

  test("volume change is null when previous bar volume is 0", () => {
    const bars = [
      makeBar(0, 100, 101, 99, 100.5, 50),
      makeBar(1, 100.5, 102, 99, 101, 0),
      makeBar(2, 101, 103, 99, 101.5, 60),
    ];
    const features = lastBarFeatures(bars);
    expect(features!.volumeChange).toBe(null);
  });

  test("dead trim applied when live start >= lookback", () => {
    const flat = makeFlatBars(15);
    const live = makeLiveBars(25);
    const bars = flat.concat(live);
    const features = lastBarFeatures(bars);
    expect(features!.trimmed).toBe(true);
    expect(features!.liveStartIdx).toBe(15);
  });
});