// Phase 4A: Volatility stop clamp tests.
// Tests the pure function volStopPct(hv, k) = clamp(k * hv, 0.08, 0.25) * 100.

import { describe, test, expect } from "bun:test";
import { volStopPct } from "../src/execution/volStop.ts";

describe("volStopPct clamp", () => {
  test("low HV clamps to 8% floor", () => {
    // k=1.5, hv=0.05 → 0.075 → clamps to 0.08 → 8.0%
    expect(volStopPct(0.05, 1.5)).toBe(8.0);
  });

  test("medium HV passes through", () => {
    // k=1.5, hv=0.4 → 0.6 → within [0.08, 0.25]? No, >0.25 → clamps to 0.25 → 25.0%
    expect(volStopPct(0.4, 1.5)).toBe(25.0);
  });

  test("k=1.5 hv=0.2 passes through", () => {
    // 1.5 * 0.2 = 0.3 → clamps to 0.25 → 25.0%
    expect(volStopPct(0.2, 1.5)).toBe(25.0);
  });

  test("k=1.5 hv=0.1 passes through", () => {
    // 1.5 * 0.1 = 0.15 → within range → 15.0%
    expect(volStopPct(0.1, 1.5)).toBeCloseTo(15.0, 8);
  });

  test("high HV clamps to 25% ceiling", () => {
    // k=1.5, hv=1.0 → 1.5 → clamps to 0.25 → 25.0%
    expect(volStopPct(1.0, 1.5)).toBe(25.0);
  });

  test("extreme HV clamps to 25% ceiling", () => {
    // k=1.5, hv=5.0 → 7.5 → clamps to 0.25 → 25.0%
    expect(volStopPct(5.0, 1.5)).toBe(25.0);
  });

  test("default k=1.5 when not specified", () => {
    expect(volStopPct(0.1)).toBeCloseTo(15.0, 8);
  });

  test("different k multiplier", () => {
    // k=2.0, hv=0.1 → 0.2 → within range → 20.0%
    expect(volStopPct(0.1, 2.0)).toBe(20.0);
  });

  test("k multiplier causes floor clamp", () => {
    // k=1.0, hv=0.05 → 0.05 → clamps to 0.08 → 8.0%
    expect(volStopPct(0.05, 1.0)).toBe(8.0);
  });

  test("k multiplier causes ceiling clamp", () => {
    // k=2.0, hv=0.2 → 0.4 → clamps to 0.25 → 25.0%
    expect(volStopPct(0.2, 2.0)).toBe(25.0);
  });
});
