import { describe, test, expect } from "bun:test";
import { mfePct, maePct, excursionSnippet } from "./excursion.ts";

describe("excursion helpers", () => {
  test("MFE and MAE with standard values", () => {
    const entry = 1.0;
    const peak = 1.4;
    const trough = 0.94;

    expect(mfePct(entry, peak)).toBeCloseTo(40.0, 1);
    expect(maePct(entry, trough)).toBeCloseTo(-6.0, 1);
  });

  test("MFE and MAE with zero peak/trough", () => {
    expect(mfePct(1, 0)).toBe(0);
    expect(maePct(1, 0)).toBe(0);
  });

  test("excursion snippet format", () => {
    const snippet = excursionSnippet(1.0, 1.4, 0.94, 0.35, "CHOP");
    expect(snippet).toContain("MFE +40.0%");
    expect(snippet).toContain("MAE -6.0%");
    expect(snippet).toContain("hv=0.35");
    expect(snippet).toContain("regime=CHOP");
  });

  test("excursion snippet with null HV", () => {
    const snippet = excursionSnippet(1.0, 1.2, 0.98, null, null);
    expect(snippet).toContain("MFE +20.0%");
    expect(snippet).toContain("MAE -2.0%");
    expect(snippet).toContain("hv=na");
    expect(snippet).toContain("regime=na");
  });
});
