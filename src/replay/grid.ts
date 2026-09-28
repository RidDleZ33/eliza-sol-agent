// Phase 4C: Replay lever grid — sweep EXIT_ATR_K and report stop-fire counts.
// Read-only. No swaps, no watchlist writes.

import { replayTape } from "./replay.ts";
import { openDb, closeDb, getDb } from "../tape/db";
import { tier, can } from "../entitlements/tier.ts";

const fs = require("fs");

interface Tick {
  observed_at_ms: number;
  mint: string;
  price_usd: number;
}

function loadTicksFromDb(dbPath: string): Tick[] {
  openDb(dbPath);
  const db = getDb();
  try {
    const rows = db.prepare(
      "SELECT observed_at_ms, mint, price_usd FROM market_ticks WHERE price_usd IS NOT NULL ORDER BY observed_at_ms ASC"
    ).all();
    return rows.map((r: any) => ({
      observed_at_ms: r.observed_at_ms,
      mint: r.mint,
      price_usd: r.price_usd,
    }));
  } finally {
    closeDb();
  }
}

function loadTicksFromJsonl(filePath: string): Tick[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim().length > 0);
  const ticks: Tick[] = [];
  for (const line of lines) {
    try {
      const tick = JSON.parse(line);
      if (tick.price_usd != null) {
        ticks.push({
          observed_at_ms: tick.observed_at_ms,
          mint: tick.mint,
          price_usd: tick.price_usd,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  return ticks;
}

const kValues = [1.0, 1.5, 2.0];

if (!can("run_replay")) {
  console.log(`tier ${tier()} too low for grid`);
  process.exit(0);
}

let ticks: Tick[] = [];
const dbPath = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";

const jsonlArg = process.argv.find(arg => arg.startsWith("--jsonl="));
if (jsonlArg) {
  const jsonlPath = jsonlArg.split("=")[1];
  ticks = loadTicksFromJsonl(jsonlPath);
} else {
  try {
    fs.accessSync(dbPath);
  } catch {
    console.log("no tape; nothing to replay");
    process.exit(0);
  }
  try {
    ticks = loadTicksFromDb(dbPath);
  } catch {
    console.log("no tape; nothing to replay");
    process.exit(0);
  }
}

if (ticks.length === 0) {
  console.log("no tape; nothing to replay");
  process.exit(0);
}

console.log("REPLAY LEVER GRID (EXIT_ATR_K sweep)");
console.log("k    stops  mints");
for (const k of kValues) {
  const result = replayTape(ticks, { k });
  console.log(`${k.toFixed(1)}  ${result.stops}    ${result.mints}`);
}

// MAX_TRADE_SIZE_SOL columns would go here once notionals are simulated
// For now: size is not part of replay (Phase 4C = read-only)