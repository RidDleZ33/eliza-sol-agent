// Clock sweep: analyze time-to-stop distribution and exit policy backtesting
// Usage: bun run tape:clock
// Read-only. Never writes to the tape.
//
// Universe: mints with first tick under 60 min after pair creation,
//          liq_usd >= 10000, price > 0. Entry is that first tick.
// Split: 80/20 by first-tick time into train and holdout.
//
// Down from entry: share of mints whose price is at or below -15% and -25%
//                  at 1 min, 10 min, and 30 min. Mint with no tick in window
//                  counts as not down.
//
// Exit from entry: sell at last tick at or before 10 min, or at 1.3x cap
//                 if it hits before 10 min. Otherwise sell at 10 min.
//                 Print n, hit rate, median return, sum of returns.

import { existsSync } from "fs";
import { discoverTapeFiles } from "./filelist";

const Database = require("better-sqlite3");

const files = discoverTapeFiles(true);

if (files.length === 0) {
  console.log("no tape files found; run `bun run tape` first");
  process.exit(0);
}

console.log(`reading ${files.length} tape file(s)`);

const dbs = files.map((f) => {
  const db = new Database(f.path, { readonly: true });
  db.pragma("cache_size = -64000");
  return { db, path: f.path };
});

function queryAll<T>(sql: string, params: any[] = []): T[] {
  const results: T[] = [];
  for (const { db } of dbs) {
    try {
      const rows = db.prepare(sql).all(...params) as T[];
      results.push(...rows);
    } catch {
      // ignore
    }
  }
  return results;
}

// Collect all mints with their first tick time
const mintRows = queryAll<{ mint: string; first_tick_ms: number }>(
  "SELECT mint, MIN(observed_at_ms) as first_tick_ms FROM market_ticks GROUP BY mint"
);

mintRows.sort((a, b) => a.first_tick_ms - b.first_tick_ms);

const split = Math.floor(mintRows.length * 0.8);
const trainMints = mintRows.slice(0, split).map((r) => r.mint);
const holdoutMints = mintRows.slice(split).map((r) => r.mint);

console.log(`mints: total=${mintRows.length} train=${trainMints.length} holdout=${holdoutMints.length}`);

// For a mint, find entry tick (first tick within 60 min of pair creation, liq >= 10000)
function getEntry(mint: string) {
  const ticks = queryAll<{
    observed_at_ms: number;
    price_usd: number | null;
    liq_usd: number | null;
    pair_created_at_ms: number | null;
  }>(
    "SELECT observed_at_ms, price_usd, liq_usd, pair_created_at_ms FROM market_ticks WHERE mint = ? ORDER BY observed_at_ms ASC",
    [mint]
  );

  if (ticks.length < 1) return null;

  const first_tick_ms = ticks[0].observed_at_ms;
  const pair_created_at_ms = ticks[0].pair_created_at_ms;

  if (pair_created_at_ms != null) {
    const ageMs = first_tick_ms - pair_created_at_ms;
    if (ageMs >= 60 * 60000) return null;
  }

  for (const t of ticks) {
    if (t.liq_usd != null && t.liq_usd >= 10000 && t.price_usd != null && t.price_usd > 0) {
      return { tick: t, ticks };
    }
  }
  return null;
}

// Check if price at or below threshold at specific time windows
function checkDown(entry, minutes: number, threshold: number) {
  const windowMs = minutes * 60000;
  const targetMs = entry.tick.observed_at_ms + windowMs;

  // Find tick closest to target within window
  let bestTick = null;
  for (const t of entry.ticks) {
    if (t.observed_at_ms <= targetMs) {
      if (t.price_usd != null) {
        bestTick = t;
      }
    }
  }

  if (bestTick == null) return false; // no tick in window = not down

  const entryPrice = entry.tick.price_usd;
  const tickPrice = bestTick.price_usd;
  const change = (tickPrice - entryPrice) / entryPrice;
  return change <= threshold;
}

// Exit at last tick before or at 10 min
function exitAt10Min(entry) {
  const targetMs = entry.tick.observed_at_ms + 10 * 60000;

  let lastTick = null;
  for (const t of entry.ticks) {
    if (t.observed_at_ms <= targetMs) {
      lastTick = t;
    }
  }

  if (lastTick == null) return null;
  if (lastTick.price_usd == null) return null;

  const entryPrice = entry.tick.price_usd;
  return lastTick.price_usd / entryPrice - 1;
}

// Exit at 1.3x cap or last tick before 10 min
function exitAtCap(entry) {
  const targetMs = entry.tick.observed_at_ms + 10 * 60000;
  const entryPrice = entry.tick.price_usd;
  const capPrice = entryPrice * 1.3;

  // Check for cap hit
  let hitTick = null;
  for (const t of entry.ticks) {
    if (t.price_usd != null && t.price_usd >= capPrice) {
      if (t.observed_at_ms <= targetMs) {
        hitTick = t;
      }
    }
  }

  if (hitTick != null) {
    return { price: capPrice, hit: true };
  }

  // No cap hit, use last tick
  let lastTick = null;
  for (const t of entry.ticks) {
    if (t.observed_at_ms <= targetMs) {
      lastTick = t;
    }
  }

  if (lastTick == null) return null;
  if (lastTick.price_usd == null) return null;

  return { price: lastTick.price_usd, hit: false };
}

// Evaluate down metrics for a set of mints
function evalDown(mints: string[], minutes: number, threshold: number) {
  let downCount = 0;
  let total = 0;
  for (const mint of mints) {
    const entry = getEntry(mint);
    if (entry == null) continue;
    total++;
    if (checkDown(entry, minutes, threshold)) {
      downCount++;
    }
  }
  return { downCount, total };
}

// Evaluate exit metrics for a set of mints
function evalExit(mints: string[], exitFn: any) {
  let returns = [];
  let hits = 0;
  let n = 0;
  for (const mint of mints) {
    const entry = getEntry(mint);
    if (entry == null) continue;
    n++;
    const result = exitFn(entry);
    if (result == null) continue;
    const entryPrice = entry.tick.price_usd;
    let ret;
    if (typeof result === "object") {
      ret = result.price / entryPrice - 1;
      if (result.hit) hits++;
    } else {
      ret = result;
    }
    returns.push(ret);
  }
  return { returns, hits, n };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr[mid];
}

function sum(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

// Down from entry: -15% and -25% at 1, 10, 30 min
console.log("\nDOWN FROM ENTRY (share of mints at or below threshold):");
console.log("mint down at threshold");
console.log("----------------------------------------------------");

for (const threshold of [-0.15, -0.25]) {
  for (const minutes of [1, 10, 30]) {
    for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]]) {
      const { downCount, total } = evalDown(mints, minutes, threshold);
      const share = total > 0 ? (downCount / total) * 100 : 0;
      console.log(`${splitName} ${threshold * 100}% at ${minutes}min: ${downCount}/${total} (${share.toFixed(1)}%)`);
    }
  }
}

// Exit from entry
console.log("\nEXIT FROM ENTRY (sell at last tick at/before 10 min or 1.3x cap):");
console.log("policy     split    n     hit%   median%  sum%");
console.log("----------------------------------------------------");

for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]]) {
  // Exit at 10 min (last tick)
  const r10 = evalExit(mints, exitAt10Min);
  if (r10.n > 0) {
    const hitPct = (r10.hits / r10.n) * 100;
    const med = median(r10.returns) * 100;
    const s = sum(r10.returns) * 100;
    console.log(`10min      ${splitName}    ${r10.n}   ${hitPct.toFixed(1)}%  ${med.toFixed(1)}%  ${s.toFixed(1)}%`);
  } else {
    console.log(`10min      ${splitName}    0   -  -  -`);
  }

  // Exit at 1.3x cap or last tick before 10 min
  const rcap = evalExit(mints, exitAtCap);
  if (rcap.n > 0) {
    const hitPct = (rcap.hits / rcap.n) * 100;
    const med = median(rcap.returns) * 100;
    const s = sum(rcap.returns) * 100;
    console.log(`1.3x cap   ${splitName}    ${rcap.n}   ${hitPct.toFixed(1)}%  ${med.toFixed(1)}%  ${s.toFixed(1)}%`);
  } else {
    console.log(`1.3x cap   ${splitName}    0   -  -  -`);
  }
}

for (const { db } of dbs) {
  db.close();
}

console.log("\ndone");