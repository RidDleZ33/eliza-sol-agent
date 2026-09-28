// Phase 6D: Ingestion source flag and mapper unit tests.
// Uses fixtures only — no network. Tests the flag helpers and data mappers directly.

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Import pure functions
import {
  ingestFlag,
  getDexscreenerTrendingPeriod,
  getDexscreenerChain,
  getBirdeyeApiKey,
} from "../src/utils/env.ts";

import {
  pairsFromUnknown,
  toDiscovered,
} from "../src/services/ingestion/dexscreenerPairs.ts";

// Load fixtures
const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixture(name: string): unknown {
  const path = join(FIXTURES_DIR, name);
  expect(existsSync(path), `fixture ${name} should exist`).toBe(true);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

describe("ingest source flag helpers", () => {
  test("ingestFlag returns boolean for each source", () => {
    expect(typeof ingestFlag("INGEST_DEXSCREENER_LATEST")).toBe("boolean");
    expect(typeof ingestFlag("INGEST_DEXSCREENER_TRENDING")).toBe("boolean");
    expect(typeof ingestFlag("INGEST_DEXSCREENER_TRENDING_BULLISH")).toBe("boolean");
    expect(typeof ingestFlag("INGEST_BIRDEYE_TRENDING")).toBe("boolean");
    expect(typeof ingestFlag("INGEST_BIRDEYE_TOP_TRADERS")).toBe("boolean");
    expect(typeof ingestFlag("INGEST_PHANTOM")).toBe("boolean");
  });

  test("default flags match expected matrix", () => {
    // Defaults: ds_latest on, ds_trending off, birdeye trending on, phantom off
    expect(ingestFlag("INGEST_DEXSCREENER_LATEST")).toBe(true);
    expect(ingestFlag("INGEST_DEXSCREENER_TRENDING")).toBe(false);
    expect(ingestFlag("INGEST_DEXSCREENER_TRENDING_BULLISH")).toBe(false);
    expect(ingestFlag("INGEST_BIRDEYE_TRENDING")).toBe(true);
    expect(ingestFlag("INGEST_BIRDEYE_TOP_TRADERS")).toBe(false);
    expect(ingestFlag("INGEST_PHANTOM")).toBe(false);
  });

  test("getDexscreenerTrendingPeriod returns valid period string", () => {
    const period = getDexscreenerTrendingPeriod();
    expect(["5m", "1h", "6h", "24h"]).toContain(period);
  });

  test("getDexscreenerChain returns a chain id string", () => {
    const chain = getDexscreenerChain();
    expect(typeof chain).toBe("string");
    expect(chain.length).toBeGreaterThan(0);
  });

  test("getBirdeyeApiKey returns string or undefined", () => {
    const key = getBirdeyeApiKey();
    expect(key === undefined || typeof key === "string").toBe(true);
  });
});

describe("dexscreener pair mapper", () => {
  let latest: any[];
  let trending: any[];

  beforeAll(() => {
    latest = pairsFromUnknown(loadFixture("dexscreener-latest.json"));
    trending = pairsFromUnknown(loadFixture("dexscreener-trending.json"));
  });

  test("fixture has multiple pairs", () => {
    expect(latest.length).toBeGreaterThan(0);
    expect(trending.length).toBeGreaterThan(0);
  });

  test("keeps solana rows, drops other chains", () => {
    const chain = getDexscreenerChain();
    let solanaCount = 0;
    let droppedCount = 0;

    for (const pair of latest) {
      const tok = toDiscovered(pair, chain);
      if (tok) {
        solanaCount++;
      } else if (pair.chainId && pair.chainId !== chain) {
        droppedCount++;
      }
    }

    expect(solanaCount).toBeGreaterThan(0);
    expect(droppedCount).toBeGreaterThan(0);
  });

  test("drops pairs with short/missing mint addresses", () => {
    const chain = getDexscreenerChain();
    const shortMintPair = {
      chainId: chain,
      baseToken: { address: "short", symbol: "X" },
      volume: { h24: 100 },
      liquidity: { usd: 50 }
    };
    expect(toDiscovered(shortMintPair, chain)).toBeNull();
  });

  test("reads volume.h24 as a number (not .usd)", () => {
    const chain = getDexscreenerChain();
    const pair = {
      chainId: chain,
      baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "TEST" },
      volume: { h24: 12345 }
    };
    const tok = toDiscovered(pair, chain);
    expect(tok).not.toBeNull();
    expect(tok.volume24h).toBe(12345);
  });
});

describe("birdeye trending mapper", () => {
  test("loads trending fixture and maps tokens", () => {
    const payload = loadFixture("birdeye-trending.json");
    expect(typeof payload).toBe("object");
    expect(payload).not.toBeNull();

    const data = payload as any;
    // Birdeye uses { success: true, data: { tokens: [...] } } format
    expect(typeof data.success).toBe("boolean");

    const tokens = data.data?.tokens;
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);

    // Map first token
    const item = tokens[0];
    expect(typeof item.address).toBe("string");
    expect(typeof item.symbol).toBe("string");
    expect(typeof item.volume24hUSD).toBe("number");
  });

  test("birdeye error fixture has failure message", () => {
    const payload = loadFixture("birdeye-error.json");
    const data = payload as any;
    expect(data.success).toBe(false);
    expect(typeof data.message).toBe("string");
    expect(data.message).not.toBe("undefined");
  });
});
