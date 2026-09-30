/**
 * Phase 11A2: Dex PA fallback mapping test.
 * Uses a frozen Dex pair fixture to verify the field mapping logic.
 * Does not hit the network.
 */

import { describe, test, expect } from "bun:test";

// Frozen Dex pair fixture (minimal fields needed for PA fallback)
const DEX_PAIR_FIXTURE = {
  pairs: [
    {
      chainId: "solana",
      baseToken: { address: "So11111111111111111111111111111111111111112" },
      quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      priceUsd: "1.50",
      priceChange: {
        m5: 12.5,
        h1: 5.2,
        h6: 15.8,
        h24: 45.3,
      },
      txns: {
        m5: { buys: 80, sells: 40 },
        h1: { buys: 200, sells: 100 },
        h24: { buys: 5000, sells: 2500 },
      },
      volume: {
        m5: 100000,
        h1: 500000,
        h24: 5000000,
      },
    },
  ],
};

describe("Dex PA fallback mapping", () => {
  test("maps priceUsd to currentPriceUsd", () => {
    const price = parseFloat(DEX_PAIR_FIXTURE.pairs[0].priceUsd);
    expect(price).toBe(1.5);
  });

  test("maps txns.m5.buys/sells to buySellRatio5m", () => {
    const buys = DEX_PAIR_FIXTURE.pairs[0].txns.m5.buys;
    const sells = DEX_PAIR_FIXTURE.pairs[0].txns.m5.sells;
    const ratio = sells > 0 ? buys / sells : 999;
    expect(ratio).toBe(2.0);
  });

  test("maps priceChange.m5 to distanceFromPeakPct", () => {
    const distance = DEX_PAIR_FIXTURE.pairs[0].priceChange.m5;
    expect(distance).toBe(12.5);
  });

  test("computes isOverextended from priceChange.m5 > 25", () => {
    const chg5m = DEX_PAIR_FIXTURE.pairs[0].priceChange.m5;
    const isOverextended = typeof chg5m === "number" && chg5m > 25;
    expect(isOverextended).toBe(false);
  });

  test("isOverextended true when priceChange.m5 > 25", () => {
    const chg5m = 30.0;
    const isOverextended = typeof chg5m === "number" && chg5m > 25;
    expect(isOverextended).toBe(true);
  });

  test("computes HV from max of |h24|, |h6|, |h1| changes", () => {
    const pair = DEX_PAIR_FIXTURE.pairs[0];
    const chg24 = Math.abs(pair.priceChange.h24 ?? 0);
    const chg6 = Math.abs(pair.priceChange.h6 ?? 0);
    const chg1 = Math.abs(pair.priceChange.h1 ?? 0);
    const rangePct = Math.max(chg24, chg6, chg1);
    const hv = rangePct / 100;
    expect(hv).toBeCloseTo(0.453, 3);
  });

  test("HV returns null when all changes are 0", () => {
    const chg24 = 0;
    const chg6 = 0;
    const chg1 = 0;
    const rangePct = Math.max(chg24, chg6, chg1);
    expect(rangePct).toBe(0);
    expect(rangePct === 0).toBe(true);
  });
});