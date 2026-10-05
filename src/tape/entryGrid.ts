// Entry clock sweep: replay entry timing on 1-minute tape bars
// Usage: bun run tape:entry
// Read-only. Never writes to the tape.
//
// Entries: first bar, bar 8, bar 21, first bar >= 21 where EMA(9) >= EMA(21)
// Exit:  first later close >= 1.3x entry close, else last close.
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

  if (ticks.length < 21) return { bars: [], first_tick_ms: ticks[0]?.observed_at_ms || 0, pair_created_at_ms: ticks[0]?.pair_created_at_ms };

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

// Evaluate entry policy for a single mint
// clock: 0=first bar, 8=bar 8, 21=bar 21, 99=first bar >= 21 where EMA9>=EMA21
// Returns return factor (exit_price / entry_price - 1) or null if no entry
function evalClock(mint: string, clock: number): number | null {
  const { bars, first_tick_ms, pair_created_at_ms } = buildBars(mint);
  if (bars.length < 21) return null;

  // Check first tick within 60 min of pair creation
  if (pair_created_at_ms != null) {
    const ageMs = first_tick_ms - pair_created_at_ms;
    if (ageMs >= 60 * 60000) return null;
  }

  const closes = bars.map((b) => b.close);

  // Determine entry bar index
  let entryBar = -1;
  if (clock === 0) {
    entryBar = 0;
  } else if (clock === 8) {
    entryBar = 7; // bar 8 is index 7
  } else if (clock === 21) {
    entryBar = 20; // bar 21 is index 20
  } else if (clock === 99) {
    // First bar >= 21 where EMA(9) >= EMA(21), computed only on bars so far
    for (let n = 20; n < bars.length; n++) {
      const closesSoFar = closes.slice(0, n + 1);
      const ema9 = ema(closesSoFar, 9)[n];
      const ema21 = ema(closesSoFar, 21)[n];
      if (ema9 >= ema21) {
        entryBar = n;
        break;
      }
    }
  }

  if (entryBar < 0 || entryBar >= bars.length) return null;

  // Liquidity check on nearest tick (first tick of entry bar)
  const nearestTick = bars[entryBar].ticks[0];
  if (nearestTick.liq_usd == null || nearestTick.liq_usd < 10000) return null;

  // Exit: first later close >= 1.3x entry close, else last close
  const entryClose = closes[entryBar];
  let exitClose = closes[closes.length - 1];
  for (let n = entryBar + 1; n < bars.length; n++) {
    if (closes[n] >= entryClose * 1.3) {
      exitClose = closes[n];
      break;
    }
  }

  return exitClose / entryClose - 1;
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
  const trainResults: number[] = [];
  const holdoutResults: number[] = [];

  for (const mint of trainMints) {
    const ret = evalClock(mint, cfg.clock);
    if (ret != null) trainResults.push(ret);
  }

  for (const mint of holdoutMints) {
    const ret = evalClock(mint, cfg.clock);
    if (ret != null) holdoutResults.push(ret);
  }

  const trainMedian = median(trainResults) * 100;
  const holdoutMedian = median(holdoutResults) * 100;

  console.log(
    `${cfg.label}: train_n=${trainResults.length} train_med=${trainMedian.toFixed(1)}p ` +
    `holdout_n=${holdoutResults.length} holdout_med=${holdoutMedian.toFixed(1)}p`
  );
}

db.close();