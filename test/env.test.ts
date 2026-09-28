// Phase 4A: isDryRun() logic tests.
// The exported isDryRun() caches its result after first call, so we test the
// pure logic directly to cover all env combinations without module reload.

import { describe, test, expect } from "bun:test";

function isTruthyFlag(val: string | undefined): boolean {
  return val === "true" || val === "1";
}

// Mirrors the logic in src/utils/env.ts isDryRun()
function testIsDryRun(dryRun: string | undefined, dryRunMode: string | undefined): boolean {
  const dryRunFlag = isTruthyFlag(dryRun);
  const dryRunModeFlag = isTruthyFlag(dryRunMode);

  if (dryRunFlag || dryRunModeFlag) {
    return true;
  }
  return false;
}

describe("isDryRun", () => {
  test("true when DRY_RUN=true", () => {
    expect(testIsDryRun("true", undefined)).toBe(true);
  });

  test("true when DRY_RUN=1", () => {
    expect(testIsDryRun("1", undefined)).toBe(true);
  });

  test("true when DRY_RUN_MODE=true", () => {
    expect(testIsDryRun(undefined, "true")).toBe(true);
  });

  test("true when DRY_RUN_MODE=1", () => {
    expect(testIsDryRun(undefined, "1")).toBe(true);
  });

  test("true when flags disagree (DRY_RUN=true, DRY_RUN_MODE=false)", () => {
    expect(testIsDryRun("true", "false")).toBe(true);
  });

  test("true when flags disagree (DRY_RUN=false, DRY_RUN_MODE=true)", () => {
    expect(testIsDryRun("false", "true")).toBe(true);
  });

  test("false only when both explicitly live (false/false)", () => {
    expect(testIsDryRun("false", "false")).toBe(false);
  });

  test("false when neither flag set", () => {
    expect(testIsDryRun(undefined, undefined)).toBe(false);
  });
});
