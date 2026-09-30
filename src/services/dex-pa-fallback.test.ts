/**
 * Phase 11A3: mapDexPairToMetrics pure-function test.
 * Uses a frozen Dex pair fixture to verify the field mapping logic.
 * No network, no DB.
 */

import { describe, test, expect } from "bun:test";
import { mapDexPairToMetrics } from "./PriceActionService.ts";

// Frozen Dex pair fixture: buys 40, sells 44, chg m5 2.69, h24 457
const DEX_PAIR_FIXTURE = {
  chainId: "solana",
  pairAddress: "FakePairAddr11111111111111111111111111",
  dexId: "raydium",
  baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "FKCANCER" },
  quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  priceUsd: "1.50",
  priceChange: {
    m5: 2.69,
    h1: 5.2,
    h6: 15.8,
    h24: 457,
  },
  txns: {
    m5: { buys: 40, sells: 44 },
    h1: { buys: 200, sells: 100 },
    h24: { buys: 5000, sells: 2500 },
  },
  volume: {
    m5: 100000,
    h1: 500000,
    h24: 5000000,
  },
  liquidity: { usd: 50000 },
};

describe("mapDexPairToMetrics (phase 11a3)", () => {
  test("maps priceUsd to currentPriceUsd", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics).not.toBeNull();
    expect(metrics!.currentPriceUsd).toBe(1.5);
  });

  test("maps txns.m5.buys/sells to buySellRatio5m (40/44 ≈ 0.91)", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.buySellRatio5m).toBeCloseTo(0.90909, 4);
  });

  test("maps priceChange.m5 to distanceFromPeakPct", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.distanceFromPeakPct).toBe(2.69);
  });

  test("isOverextended false when priceChange.m5 ≤ 25", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.isOverextended).toBe(false);
  });

  test("isOverextended true when priceChange.m5 > 25", () => {
    const hotPair = {
      ...DEX_PAIR_FIXTURE,
      priceChange: { m5: 30.0, h1: 10, h6: 20, h24: 50 },
    };
    const metrics = mapDexPairToMetrics(hotPair);
    expect(metrics!.isOverextended).toBe(true);
  });

  test("sets source to 'dex'", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.source).toBe("dex");
  });

  test("returns null when priceUsd is missing", () => {
    const noPrice = { ...DEX_PAIR_FIXTURE, priceUsd: undefined };
    expect(mapDexPairToMetrics(noPrice)).toBeNull();
  });

  test("buySellRatio is 999 when sells is 0", () => {
    const noSells = {
      ...DEX_PAIR_FIXTURE,
      txns: { ...DEX_PAIR_FIXTURE.txns, m5: { buys: 10, sells: 0 } },
    };
    const metrics = mapDexPairToMetrics(noSells);
    expect(metrics!.buySellRatio5m).toBe(999);
  });

  test("emaTrend is NEUTRAL for dex source", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.emaTrend).toBe("NEUTRAL");
  });

  test("vwapRatio is synthetic 1.0 for dex source", () => {
    const metrics = mapDexPairToMetrics(DEX_PAIR_FIXTURE);
    expect(metrics!.vwapRatio).toBe(1);
  });
});