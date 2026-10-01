import { describe, test, expect } from "bun:test";
import { getDexscreenerChain } from "../src/utils/env.ts";

describe("getDexscreenerChain env helper", () => {
  test("returns a string (not throwing ConfigService call)", () => {
    // This helper reads env directly; no ConfigService key lookup.
    // If INGEST_DEXSCREENER_CHAIN is not in env, it defaults to "solana".
    expect(typeof getDexscreenerChain()).toBe("string");
  });
});
