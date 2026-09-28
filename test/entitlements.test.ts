// Phase 5A entitlement feature matrix test.
// No network, no env manipulation — tests the tier → feature mapping directly.

import { FEATURES } from "../src/entitlements/tier.ts";

function has(tier: string, feature: string): boolean {
  return FEATURES[tier].has(feature);
}

describe("entitlement tier matrix", () => {
  test("operator has all features", () => {
    expect(has("operator", "run_executor")).toBe(true);
    expect(has("operator", "run_tape")).toBe(true);
    expect(has("operator", "view_trades")).toBe(true);
    expect(has("operator", "run_replay")).toBe(true);
  });

  test("desk has tape, trades, replay but not executor", () => {
    expect(has("desk", "run_executor")).toBe(false);
    expect(has("desk", "run_tape")).toBe(true);
    expect(has("desk", "view_trades")).toBe(true);
    expect(has("desk", "run_replay")).toBe(true);
  });

  test("feed has only trades", () => {
    expect(has("feed", "run_executor")).toBe(false);
    expect(has("feed", "run_tape")).toBe(false);
    expect(has("feed", "view_trades")).toBe(true);
    expect(has("feed", "run_replay")).toBe(false);
  });

  test("free has nothing", () => {
    expect(has("free", "run_executor")).toBe(false);
    expect(has("free", "run_tape")).toBe(false);
    expect(has("free", "view_trades")).toBe(false);
    expect(has("free", "run_replay")).toBe(false);
  });
});
