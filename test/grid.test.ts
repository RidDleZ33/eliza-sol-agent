import { replayTape } from "../src/replay/replay.ts";
import { describe, expect, test } from "bun:test";

// Synthetic 5-tick series: prices dip 10% at tick 3, then recover.
// Stop fires when stopPct <= 10%.
const ticks = [
  { observed_at_ms: 1000, mint: "TEST", price_usd: 1.00 },
  { observed_at_ms: 2000, mint: "TEST", price_usd: 1.01 },
  { observed_at_ms: 3000, mint: "TEST", price_usd: 0.90 },
  { observed_at_ms: 4000, mint: "TEST", price_usd: 0.95 },
  { observed_at_ms: 5000, mint: "TEST", price_usd: 1.00 },
];

describe("replay grid - k sweep", () => {
  test("larger k produces fewer or equal stops", () => {
    const small = replayTape(ticks, { k: 1.0 }).stops;
    const large = replayTape(ticks, { k: 2.0 }).stops;
    expect(large).toBeLessThanOrEqual(small);
  });

  test("grid counts are consistent across k values", () => {
    const counts = [1.0, 1.5, 2.0].map(k => replayTape(ticks, { k }).stops);
    // Counts should be monotonically non-increasing with larger k
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});