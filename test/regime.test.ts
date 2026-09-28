// Phase 4A: Market regime label tests.
// Tests the pure function labelRegime(hv) thresholds.

import { describe, test, expect } from "bun:test";

// Pure function mirroring src/services/PriceActionService.ts labelRegime
function labelRegime(hv: number): "CHOP" | "TREND" | "SHOCK" {
  if (hv < 0.40) return "CHOP";
  if (hv <= 0.80) return "TREND";
  return "SHOCK";
}

describe("labelRegime thresholds", () => {
  test("CHOP: hv < 0.40", () => {
    expect(labelRegime(0.0)).toBe("CHOP");
    expect(labelRegime(0.1)).toBe("CHOP");
    expect(labelRegime(0.39)).toBe("CHOP");
    expect(labelRegime(0.399)).toBe("CHOP");
  });

  test("TREND: 0.40 <= hv <= 0.80", () => {
    expect(labelRegime(0.40)).toBe("TREND");
    expect(labelRegime(0.5)).toBe("TREND");
    expect(labelRegime(0.6)).toBe("TREND");
    expect(labelRegime(0.79)).toBe("TREND");
    expect(labelRegime(0.80)).toBe("TREND");
  });

  test("SHOCK: hv > 0.80", () => {
    expect(labelRegime(0.81)).toBe("SHOCK");
    expect(labelRegime(0.9)).toBe("SHOCK");
    expect(labelRegime(1.0)).toBe("SHOCK");
    expect(labelRegime(5.0)).toBe("SHOCK");
  });
});
