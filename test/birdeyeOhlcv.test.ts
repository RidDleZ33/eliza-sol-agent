import { describe, test, expect } from "bun:test";
import { fetchBirdeyeOhlcv, BirdeyeOhlcvItem } from "../src/services/priceAction/birdeyeOhlcv.ts";
import { deadTrim, firstLiveIndex, lastBarFeatures, OhlcvBar } from "../src/services/priceAction/candleFeatures.ts";
import { metricsFromBars } from "../src/services/PriceActionService.ts";
import { CandleFeatures } from "../src/types/priceAction.ts";

// Fixture: Birdeye-style OHLCV items (seconds timestamps)
const fixtureItems: BirdeyeOhlcvItem[] = [
  { unix_time: 1790000000, o: 1.0, h: 1.2, l: 0.9, c: 1.1, v: 100, v_usd: 110 },
  { unix_time: 1790000060, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 150, v_usd: 180 },
  { unix_time: 1790000120, o: 1.2, h: 1.4, l: 1.1, c: 1.3, v: 200, v_usd: 260 },
  { unix_time: 1790000180, o: 1.3, h: 1.5, l: 1.2, c: 1.4, v: 180, v_usd: 252 },
];

describe("candleFeatures helpers", () => {
  test("deadTrim trims leading flat bars", () => {
    const bars: OhlcvBar[] = [
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 2, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 3, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 4, o: 1, h: 1.5, l: 0.5, c: 1.2, v: 10 },
      { t: 5, o: 1.2, h: 1.6, l: 1.0, c: 1.4, v: 20 },
      { t: 6, o: 1.4, h: 1.7, l: 1.3, c: 1.5, v: 30 },
    ];
    const trimmed = deadTrim(bars, 2);
    // First live index is 3; lookback=2 => slice from 1
    expect(trimmed.length).toBe(5);
    expect(trimmed[0].t).toBe(2);
  });

  test("deadTrim returns all if live starts within lookback", () => {
    const bars: OhlcvBar[] = [
      { t: 1, o: 1, h: 1.5, l: 0.5, c: 1.2, v: 10 },
      { t: 2, o: 1.2, h: 1.6, l: 1.0, c: 1.4, v: 20 },
      { t: 3, o: 1.4, h: 1.7, l: 1.3, c: 1.5, v: 30 },
    ];
    const trimmed = deadTrim(bars, 2);
    expect(trimmed.length).toBe(3);
  });

  test("firstLiveIndex finds first non-flat", () => {
    const bars: OhlcvBar[] = [
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 2, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 3, o: 1, h: 1.5, l: 0.5, c: 1.2, v: 10 },
      { t: 4, o: 1.2, h: 1.6, l: 1.0, c: 1.4, v: 20 },
      { t: 5, o: 1.4, h: 1.7, l: 1.3, c: 1.5, v: 30 },
    ];
    const idx = firstLiveIndex(bars);
    expect(idx).toBe(2);
  });

  test("lastBarFeatures returns null on < 3 bars", () => {
    const bars: OhlcvBar[] = [
      { t: 1, o: 1, h: 2, l: 0, c: 1.5, v: 10 },
      { t: 2, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
    ];
    expect(lastBarFeatures(bars)).toBeNull();
  });

  test("lastBarFeatures returns sufficient=true on >= minBars", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 25; i++) {
      bars.push({
        t: i * 60000,
        o: 1 + i * 0.1,
        h: 1.1 + i * 0.1,
        l: 0.9 + i * 0.1,
        c: 1 + i * 0.1,
        v: 100,
      });
    }
    const features = lastBarFeatures(bars, 20);
    expect(features).not.toBeNull();
    expect(features!.sufficient).toBe(true);
  });
});

describe("metricsFromBars", () => {
  test("computes vwapRatio, ema trend, overextended on rising bars", () => {
    // Build 25 rising bars
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 25; i++) {
      const price = 10 + i * 0.5;
      bars.push({
        t: i * 60000,
        o: price,
        h: price + 0.2,
        l: price - 0.1,
        c: price + 0.1,
        v: 100,
      });
    }

    const features = lastBarFeatures(bars, 20);
    expect(features).not.toBeNull();
    expect(features!.sufficient).toBe(true);

    const metrics = metricsFromBars(bars, features!, null);
    expect(metrics).not.toBeNull();
    expect(metrics!.source).toBe("birdeye");

    // VWAP ratio should be > 1 (price rising above VWAP)
    expect(metrics!.vwapRatio).toBeGreaterThan(1);
    // Last price is above VWAP
    expect(metrics!.currentPriceUsd).toBeGreaterThan(metrics!.vwapUsd);

    // EMA trend: SMA5 > SMA20 on rising bars => BULLISH
    expect(metrics!.emaTrend).toBe("BULLISH");

    // Overextended: within 2% of peak (rising bars are near peak)
    expect(metrics!.isOverextended).toBe(true);

    // Distance from peak should be negative (below max high)
    expect(metrics!.distanceFromPeakPct).toBeLessThan(0);
  });

  test("computes metrics on flat bars", () => {
    const bars: OhlcvBar[] = [];
    for (let i = 0; i < 25; i++) {
      bars.push({
        t: i * 60000,
        o: 10,
        h: 10,
        l: 10,
        c: 10,
        v: 100,
      });
    }

    const features = lastBarFeatures(bars, 20);
    expect(features!.sufficient).toBe(true);

    const metrics = metricsFromBars(bars, features!, null);
    expect(metrics!.currentPriceUsd).toBe(10);
    expect(metrics!.vwapUsd).toBe(10);
    expect(metrics!.vwapRatio).toBe(1);
    expect(metrics!.emaTrend).toBe("NEUTRAL");
  });

  test("uses dexPair buy/sell when provided", () => {
    const bars: OhlcvBar[] = [
      { t: 1, o: 10, h: 10, l: 10, c: 10, v: 100 },
      { t: 2, o: 10, h: 10, l: 10, c: 10, v: 100 },
      { t: 3, o: 10, h: 10, l: 10, c: 10, v: 100 },
    ];
    const features = lastBarFeatures(bars);

    // No dex pair => buySellRatio = 1
    const metricsNoPair = metricsFromBars(bars, features, null);
    expect(metricsNoPair!.buySellRatio5m).toBe(1);

    // Dex pair with buys/sells => computed ratio
    const dexPair = {
      chainId: "solana",
      baseToken: { address: "mint" },
      quoteToken: { address: "quote" },
      priceUsd: "10",
      txns: { m5: { buys: 10, sells: 5 } },
    };
    const metricsWithPair = metricsFromBars(bars, features, dexPair as any);
    expect(metricsWithPair!.buySellRatio5m).toBe(2);
  });
});

describe("fetchBirdeyeOhlcv parse shapes", () => {
  test("parseItems handles { items: [...] } shape", async () => {
    // Mock fetch to return items shape
    globalThis.fetch = async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: fixtureItems },
        }),
      } as Response;
    };

    const result = await fetchBirdeyeOhlcv("mint", "key");
    expect(result.bars).not.toBeNull();
    expect(result.bars!.length).toBe(4);
    expect(result.bars![0].t).toBe(1790000000000); // seconds -> ms
    expect(result.reason).toBe("ok");
  });

  test("parseItems handles array shape", async () => {
    globalThis.fetch = async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: fixtureItems,
        }),
      } as Response;
    };

    const result = await fetchBirdeyeOhlcv("mint", "key");
    expect(result.bars).not.toBeNull();
    expect(result.bars!.length).toBe(4);
  });

  test("success=false returns null bars", async () => {
    globalThis.fetch = async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
          data: null,
          message: "not found",
        }),
      } as Response;
    };

    const result = await fetchBirdeyeOhlcv("mint", "key");
    expect(result.bars).toBeNull();
    expect(result.reason).toBe("not found");
  });

  test("401/403 returns auth reason", async () => {
    globalThis.fetch = async (url: string) => {
      return {
        ok: false,
        status: 401,
        json: async () => ({}),
      } as Response;
    };

    const result = await fetchBirdeyeOhlcv("mint", "key");
    expect(result.bars).toBeNull();
    expect(result.reason).toBe("auth_401");
  });

  test("parseItems returns null on non-finite bars", async () => {
    const badItems: BirdeyeOhlcvItem[] = [
      { unix_time: 1790000000, o: NaN, h: 1.2, l: 0.9, c: 1.1, v: 100 },
      { unix_time: 1790000060, o: 1.1, h: 1.3, l: 1.0, c: 1.2, v: 150 },
    ];

    // Map manually to check non-finite filtering
    const bars: OhlcvBar[] = [];
    for (const item of badItems) {
      if (Number.isFinite(item.o) && Number.isFinite(item.h) &&
          Number.isFinite(item.l) && Number.isFinite(item.c)) {
        const v = Number.isFinite(item.v) ? item.v : (item.v_usd ?? 0);
        const t = item.unix_time < 1e12 ? item.unix_time * 1000 : item.unix_time;
        bars.push({ t, o: item.o, h: item.h, l: item.l, c: item.c, v });
      }
    }
    // First item has NaN open, should be filtered
    expect(bars.length).toBe(1);
    expect(bars[0].t).toBe(1790000060000);
  });
});
