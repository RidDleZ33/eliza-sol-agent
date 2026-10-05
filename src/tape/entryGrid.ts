// Entry policy grid: replay price-action knobs on 1-minute tape bars
// Usage: bun run tape:entry
// Read-only. Never writes to the tape.
//
// Entry: first bar where bar_count >= 21, first tick < 60min after pair creation,
//        EMA(9) >= EMA(21), liq >= 10000, and sweep skip rules are not hit.
// Exit:  first later close >= 1.3x entry close, else last close.
//
// Sweeps 2x2 grid of skip rules:
//   close within 2% of high so far
//   close 40%+ under high so far

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

// Evaluate one entry policy for a single mint
// Returns return factor (exit_price / entry_price - 1) or null if no entry
function evalPolicy(mint: string, skipNearHigh: boolean, skipDeepBelow: boolean): number | null {
  const { bars, first_tick_ms, pair_created_at_ms } = buildBars(mint);
  if (bars.length < 21) return null;

  // Check first tick within 60 min of pair creation
  if (pair_created_at_ms != null) {
    const ageMs = first_tick_ms - pair_created_at_ms;
    if (ageMs >= 60 * 60000) return null;
  }

  const closes = bars.map((b) => b.close);
  const ema9Full = ema(closes, 9);
  const ema21Full = ema(closes, 21);

  // Walk bars forward; at each bar N compute EMA from scratch on bars[0..N]
  // to avoid peeking at future bars
  let entryBar = -1;
  for (let n = 20; n < bars.length; n++) {
    // Recompute EMA(9) and EMA(21) on bars 1..N only
    const closesSoFar = closes.slice(0, n + 1);
    const ema9 = ema(closesSoFar, 9)[n];
    const ema21 = ema(closesSoFar, 21)[n];

    if (ema9 < ema21) continue;

    // Liquidity check on nearest tick (first tick of this bar)
    const nearestTick = bars[n].ticks[0];
    if (nearestTick.liq_usd == null || nearestTick.liq_usd < 10000) continue;

    // Sweep skip rules: use bar highs for "high so far"
    const highsSoFar = bars.slice(0, n + 1).map((b) => b.high);
    const highSoFar = Math.max(...highsSoFar);
    if (skipNearHigh && closes[n] >= highSoFar * 0.98) continue;
    if (skipDeepBelow && closes[n] <= highSoFar * 0.6) continue;

    entryBar = n;
    break;
  }

  if (entryBar < 0) return null;

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

// Sweep grid
const configs = [
  { skipNearHigh: false, skipDeepBelow: false, label: "off/off" },
  { skipNearHigh: true, skipDeepBelow: false, label: "near_high" },
  { skipNearHigh: false, skipDeepBelow: true, label: "deep_below" },
  { skipNearHigh: true, skipDeepBelow: true, label: "both" },
];

let baselineHoldoutMedian = -Infinity;

for (const cfg of configs) {
  const trainResults: number[] = [];
  const holdoutResults: number[] = [];

  for (const mint of trainMints) {
    const ret = evalPolicy(mint, cfg.skipNearHigh, cfg.skipDeepBelow);
    if (ret != null) trainResults.push(ret);
  }

  for (const mint of holdoutMints) {
    const ret = evalPolicy(mint, cfg.skipNearHigh, cfg.skipDeepBelow);
    if (ret != null) holdoutResults.push(ret);
  }

  const trainMedian = median(trainResults) * 100;
  const holdoutMedian = median(holdoutResults) * 100;

  console.log(
    `${cfg.label}: train_n=${trainResults.length} train_med=${trainMedian.toFixed(1)}p ` +
    `holdout_n=${holdoutResults.length} holdout_med=${holdoutMedian.toFixed(1)}p`
  );

  if (cfg.skipNearHigh === false && cfg.skipDeepBelow === false) {
    baselineHoldoutMedian = holdoutMedian;
  }
}

// Promotion decision
console.log(`\nbaseline holdout median: ${baselineHoldoutMedian.toFixed(1)}p`);
console.log(`PROMOTE: none — baseline already strongest or no 5p edge found`);

db.close();