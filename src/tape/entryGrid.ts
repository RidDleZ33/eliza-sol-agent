// Entry clock sweep: replay entry timing on 1-minute tape bars
// Usage: bun run tape:entry
// Read-only. Never writes to the tape.
//
// Entries: first bar, bar 8, bar 21, first bar >= 21 where EMA(9) >= EMA(21)
// Exit:  first later tick >= 1.3x entry tick, else last tick.
// Liquidity >= 10000. First tick under 60 min after pair creation.
// No peak skips.

import { existsSync } from "fs";

const TAPE_DB = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";

if (!existsSync(TAPE_DB)) {
  console.log("tape not found at " + TAPE_DB + "; run `bun run tape` first");
  process.exit(0);
}

const Database = require("better-sqlite3");
const db = new Database(TAPE_DB, { readonly: true });
db.pragma("cache_size = -64000");

// Build 1-minute bars from ticks for a single mint
function buildBars(mint: string): { bars: any[], first_tick_ms: number, pair_created_at_ms: number | null } {
  const ticks = db
    .prepare(
      "SELECT observed_at_ms, price_usd, liq_usd, pair_created_at_ms FROM market_ticks WHERE mint = ? ORDER BY observed_at_ms ASC"
    )
    .all(mint) as {
      observed_at_ms: number;
      price_usd: number | null;
      liq_usd: number | null;
      pair_created_at_ms: number | null;
    }[];

  if (ticks.length < 1) return { bars: [], first_tick_ms: 0, pair_created_at_ms: null };

  const first_tick_ms = ticks[0].observed_at_ms;
  const pair_created_at_ms = ticks[0].pair_created_at_ms;

  // Bucket ticks into 1-minute bars
  const buckets: Map<number, any[]> = new Map();
  for (const t of ticks) {
    const minute = Math.floor(t.observed_at_ms / 60000);
    if (!buckets.has(minute)) buckets.set(minute, []);
    buckets.get(minute)!.push(t);
  }

  const bars: any[] = [];
  const minutes = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const minute of minutes) {
    const tickBucket = buckets.get(minute)!;
    const prices = tickBucket.map((t) => t.price_usd).filter((p): p is number => p != null);
    if (prices.length === 0) continue;
    bars.push({
      minute,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      ticks: tickBucket,
    });
  }

  return { bars, first_tick_ms, pair_created_at_ms };
}

// EMA of period N on a series
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// Compute capped and uncensored exits
// capped: next tick at or above 1.3x entry price, else last tick
// uncensored: always last tick
function computeExits(ticks: any[], entryTick: any): { capped: number; uncensored: number; hit: boolean } | null {
  const entryPrice = entryTick.price_usd;
  if (entryPrice == null || entryPrice <= 0) return null;
  const lastTick = ticks[ticks.length - 1];
  const lastPrice = lastTick.price_usd;
  if (lastPrice == null) return null;
  let hit = false;
  let cappedPrice = lastPrice;
  for (const t of ticks) {
    if (t.observed_at_ms <= entryTick.observed_at_ms) continue;
    if (t.price_usd != null && t.price_usd >= entryPrice * 1.3) {
      cappedPrice = t.price_usd;
      hit = true;
      break;
    }
  }
  return {
    capped: cappedPrice / entryPrice - 1,
    uncensored: lastPrice / entryPrice - 1,
    hit,
  };
}

// Evaluate entry policy for a single mint
// clock: 0=first tick with liq, 8=bar 8, 21=bar 21, 99=first bar >= 21 where EMA9>=EMA21
// Returns { capped, uncensored, hit } or null if no entry
function evalClock(mint: string, clock: number): { capped: number; uncensored: number; hit: boolean } | null {
  const ticks = db
    .prepare(
      "SELECT observed_at_ms, price_usd, liq_usd, pair_created_at_ms FROM market_ticks WHERE mint = ? ORDER BY observed_at_ms ASC"
    )
    .all(mint) as {
      observed_at_ms: number;
      price_usd: number | null;
      liq_usd: number | null;
      pair_created_at_ms: number | null;
    }[];

  if (ticks.length < 1) return null;

  const first_tick_ms = ticks[0].observed_at_ms;
  const pair_created_at_ms = ticks[0].pair_created_at_ms;

  // Check first tick within 60 min of pair creation
  if (pair_created_at_ms != null) {
    const ageMs = first_tick_ms - pair_created_at_ms;
    if (ageMs >= 60 * 60000) return null;
  }

  // clock 0: first tick with liq >= 10000
  if (clock === 0) {
    for (const t of ticks) {
      if (t.liq_usd != null && t.liq_usd >= 10000) {
        return computeExits(ticks, t);
      }
    }
    return null;
  }

  // Build bars for bar clocks
  const { bars } = buildBars(mint);

  // clock 8: first tick of bar 8
  if (clock === 8) {
    if (bars.length < 8) return null;
    const entryTick = bars[7].ticks[0];
    if (entryTick.liq_usd == null || entryTick.liq_usd < 10000) return null;
    return computeExits(ticks, entryTick);
  }

  // clock 21: first tick of bar 21
  if (clock === 21) {
    if (bars.length < 21) return null;
    const entryTick = bars[20].ticks[0];
    if (entryTick.liq_usd == null || entryTick.liq_usd < 10000) return null;
    return computeExits(ticks, entryTick);
  }

  // clock 99: first bar >= 21 where EMA(9) >= EMA(21)
  if (clock === 99) {
    if (bars.length < 21) return null;
    const closes = bars.map((b) => b.close);
    for (let n = 20; n < bars.length; n++) {
      const closesSoFar = closes.slice(0, n + 1);
      const ema9 = ema(closesSoFar, 9)[n];
      const ema21 = ema(closesSoFar, 21)[n];
      if (ema9 >= ema21) {
        const entryTick = bars[n].ticks[0];
        if (entryTick.liq_usd == null || entryTick.liq_usd < 10000) continue;
        return computeExits(ticks, entryTick);
      }
    }
  }

  return null;
}

// Median of an array
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr[mid];
}

// Collect all mints with their first tick times
const mintRows = db
  .prepare(
    "SELECT mint, MIN(observed_at_ms) as first_tick_ms FROM market_ticks GROUP BY mint"
  )
  .all() as { mint: string; first_tick_ms: number }[];

mintRows.sort((a, b) => a.first_tick_ms - b.first_tick_ms);

// Split 80/20 by time
const split = Math.floor(mintRows.length * 0.8);
const trainMints = mintRows.slice(0, split).map((r) => r.mint);
const holdoutMints = mintRows.slice(split).map((r) => r.mint);

console.log(`mints: total=${mintRows.length} train=${trainMints.length} holdout=${holdoutMints.length}`);

// Four entry clocks
const clocks = [
  { clock: 0, label: "first_bar" },
  { clock: 8, label: "bar_8" },
  { clock: 21, label: "bar_21" },
  { clock: 99, label: "ema_cross_21" },
];

for (const cfg of clocks) {
  console.log(`${cfg.label}:`);

  for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]] as const) {
    const results: { capped: number; uncensored: number; hit: boolean }[] = [];
    for (const mint of mints) {
      const r = evalClock(mint, cfg.clock);
      if (r != null) results.push(r);
    }
    if (results.length === 0) {
      console.log(`  ${splitName}: n=0`);
      continue;
    }
    const hitCount = results.filter(r => r.hit).length;
    const cappedRets = results.map(r => r.capped * 100);
    const uncensoredRets = results.map(r => r.uncensored * 100);
    const cappedMedian = median(cappedRets);
    const uncensoredMedian = median(uncensoredRets);
    console.log(
      `  ${splitName}: n=${results.length} hit=${hitCount} capped_med=${cappedMedian.toFixed(1)}p hold_med=${uncensoredMedian.toFixed(1)}p`
    );
  }
}

db.close();