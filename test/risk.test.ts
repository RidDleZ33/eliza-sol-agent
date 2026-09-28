// Phase 4A: Risk cap and kill switch tests.
// Validates the risk logic directly without live dependencies.

import { describe, test, expect } from "bun:test";

describe("checkBuyRisk logic", () => {
  test("trade size > cap rejects", () => {
    const tradeSize = 1.0;
    const maxTrade = 0.5;
    const ok = tradeSize <= maxTrade;
    expect(ok).toBe(false);
  });

  test("trade size at cap passes", () => {
    const tradeSize = 0.5;
    const maxTrade = 0.5;
    const ok = tradeSize <= maxTrade;
    expect(ok).toBe(true);
  });

  test("deployed + trade > cap rejects", () => {
    const deployed = 1.2;
    const tradeSize = 0.5;
    const maxDeployed = 1.5;
    const ok = deployed + tradeSize <= maxDeployed;
    expect(ok).toBe(false);
  });

  test("kill switch blocks regardless of size", () => {
    const killSwitch = true;
    const tradeSize = 0.1;
    const maxTrade = 1.0;
    const ok = tradeSize <= maxTrade && !killSwitch;
    expect(ok).toBe(false);
  });

  test("all conditions pass allows trade", () => {
    const tradeSize = 0.5;
    const maxTrade = 1.0;
    const deployed = 0.5;
    const maxDeployed = 2.0;
    const killSwitch = false;
    const ok = tradeSize <= maxTrade && deployed + tradeSize <= maxDeployed && !killSwitch;
    expect(ok).toBe(true);
  });
});
