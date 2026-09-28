import { volStopPct } from "../../src/execution/volStop.ts";
import { describe, expect, test } from "@stdlib/testing";

describe("replay - event-time sorting and stop computation", () => {
  test("ticks are sorted by observed_at_ms", () => {
    const ticks = [
      { observed_at_ms: 3000, mint: "A", price_usd: 1.05 },
      { observed_at_ms: 1000, mint: "A", price_usd: 1.00 },
      { observed_at_ms: 2000, mint: "A", price_usd: 1.02 },
    ];

    ticks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);

    expect(ticks[0].observed_at_ms).toBe(1000);
    expect(ticks[1].observed_at_ms).toBe(2000);
    expect(ticks[2].observed_at_ms).toBe(3000);
  });

  test("volStopPct clamps to valid range", () => {
    expect(volStopPct(0.01, 1.5)).toBe(8); // 0.015 clamped up to 0.08 = 8%
    expect(volStopPct(0.1, 1.5)).toBe(15); // 0.15 in range = 15%
    expect(volStopPct(0.5, 1.5)).toBe(25); // 0.75 clamped up to 0.25 = 25%
  });

  test("hv proxy computed from price series", () => {
    const prices = [1.0, 1.05, 0.95, 1.02];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const last = prices[prices.length - 1];
    const hv = (high - low) / last;
    expect(hv).toBeGreaterThan(0.05);
    expect(hv).toBeLessThan(0.2);
  });
});