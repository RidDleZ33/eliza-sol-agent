// Phase 4B: Event-time tape replay (read-only).
// Walks recorded ticks in observed_at_ms order, computes HV proxy from available
// window, applies volStopPct, and reports how many times a stop loss would have
// fired. No Jupiter, no Telegram, no watchlist writes.

import { openDb, closeDb, getDb } from "../tape/db";
import { volStopPct } from "../execution/volStop.ts";

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

function computeHvProxy(prices: number[]): number {
  if (prices.length < 2) return 0.01;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const last = prices[prices.length - 1];
  const hv = (high - low) / last;
  return Math.max(hv, 0.001);
}

export function replayTape(ticks: Tick[], opts?: { k?: number }) {
  const k = opts?.k ?? 1.5;

  // Group by mint
  const mints = new Map<string, Tick[]>();
  for (const tick of ticks) {
    if (!mints.has(tick.mint)) mints.set(tick.mint, []);
    mints.get(tick.mint)!.push(tick);
  }

  const results = [];
  for (const [mint, mintTicks] of mints) {
    mintTicks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);
    const prices = mintTicks.map(t => t.price_usd).filter(p => p > 0);

    if (prices.length < 5) continue;

    // Compute HV proxy from full series
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const last = prices[prices.length - 1];
    const hv = Math.max((high - low) / last, 0.001);
    const stopPct = volStopPct(hv, k);

    // Simulate: enter at first price, check if max drawdown exceeds stop
    const entry = prices[0];
    let maxDrawdown = 0;
    for (let i = 1; i < prices.length; i++) {
      const drawdown = ((entry - prices[i]) / entry) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    if (maxDrawdown >= stopPct) {
      results.push({ mint, hv, stopPct, maxDrawdown });
    }
  }

  return {
    mints: mints.size,
    stops: results.length,
    rows: results,
  };
}

function main() {
  let ticks: Tick[] = [];
  const dbPath = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";

  // Check for --jsonl argument
  const jsonlArg = process.argv.find(arg => arg.startsWith("--jsonl="));
  if (jsonlArg) {
    const jsonlPath = jsonlArg.split("=")[1];
    ticks = loadTicksFromJsonl(jsonlPath);
  } else {
    // Check if DB exists
    try {
      fs.accessSync(dbPath);
    } catch {
      console.log("no tape; nothing to replay");
      process.exit(0);
    }
    try {
      ticks = loadTicksFromDb(dbPath);
    } catch (e: any) {
      console.log("no tape; nothing to replay");
      process.exit(0);
    }
  }

  if (ticks.length === 0) {
    console.log("no tape; nothing to replay");
    process.exit(0);
  }

  // Group by mint
  const mints = new Map<string, Tick[]>();
  for (const tick of ticks) {
    if (!mints.has(tick.mint)) mints.set(tick.mint, []);
    mints.get(tick.mint)!.push(tick);
  }

  let totalTicks = 0;
  let totalStops = 0;
  const results = [];

  for (const [mint, mintTicks] of mints) {
    mintTicks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);
    const prices = mintTicks.map(t => t.price_usd).filter(p => p > 0);
    totalTicks += prices.length;

    if (prices.length < 5) continue;

    // Compute HV proxy from full series
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const last = prices[prices.length - 1];
    const hv = Math.max((high - low) / last, 0.001);
    const stopPct = volStopPct(hv, 1.5);

    // Simulate: enter at first price, check if max drawdown exceeds stop
    const entry = prices[0];
    let maxDrawdown = 0;
    for (let i = 1; i < prices.length; i++) {
      const drawdown = ((entry - prices[i]) / entry) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    if (maxDrawdown >= stopPct) {
      results.push({ mint, hv, stopPct, maxDrawdown });
      totalStops++;
    }
  }

  console.log("REPLAY SUMMARY");
  console.log(`Total ticks: ${totalTicks}`);
  console.log(`Mints with data: ${mints.size}`);
  console.log(`Mints that would have stopped out: ${totalStops}`);
  console.log("");

  if (results.length > 0) {
    console.log("Mints with stop fires:");
    for (const r of results.slice(0, 20)) {
      console.log(`  ${r.mint}: hv=${r.hv.toFixed(4)} stop=${r.stopPct.toFixed(1)}% maxDD=${r.maxDrawdown.toFixed(1)}%`);
    }
    if (results.length > 20) {
      console.log(`  ... and ${results.length - 20} more`);
    }
  }
}

// Only run main() when replay.ts is executed directly, not when imported.
const isEntryPoint = process.argv[1]?.includes("replay.ts");
if (isEntryPoint) {
  main();
}