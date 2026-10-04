// Tape path report: per-mint runup/giveback analysis
// Usage: bun src/tape/paths.ts
// Read-only. Never writes to the tape.

import { existsSync } from "fs";

const TAPE_DB = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";

if (!existsSync(TAPE_DB)) {
  console.log("tape not found at " + TAPE_DB + "; run `bun run tape` first");
  process.exit(0);
}

const Database = require("better-sqlite3");
const db = new Database(TAPE_DB, { readonly: true });
db.pragma("cache_size = -64000");

type PathRow = {
  mint: string;
  tick_count: number;
  first_seen_ms: number;
  pair_created_at_ms: number | null;
  first_price: number;
  max_price: number;
};

// Per-mint path stats: first tick price, peak, pair creation time
const rows = db
  .prepare(`
    SELECT
      mint,
      COUNT(*) AS tick_count,
      MIN(observed_at_ms) AS first_seen_ms,
      MIN(pair_created_at_ms) AS pair_created_at_ms,
      (SELECT price_usd FROM market_ticks t2
       WHERE t2.mint = t1.mint ORDER BY t2.observed_at ASC LIMIT 1) AS first_price,
      MAX(price_usd) AS max_price
    FROM market_ticks t1
    WHERE price_usd > 0
    GROUP BY mint
    HAVING tick_count >= 3
  `)
  .all() as PathRow[];

console.log(`path report: ${rows.length} mints`);

let runners = 0;
let roundtrips = 0;
const runups: number[] = [];

// Age buckets
type Bucket = { n: number; runners: number; roundtrips: number; runups: number[] };
const bucketUnder30: Bucket = { n: 0, runners: 0, roundtrips: 0, runups: [] };
const bucket30To60: Bucket = { n: 0, runners: 0, roundtrips: 0, runups: [] };
const bucketOver60: Bucket = { n: 0, runners: 0, roundtrips: 0, runups: [] };
const bucketUnknown: Bucket = { n: 0, runners: 0, roundtrips: 0, runups: [] };

function classifyBucket(row: PathRow): Bucket | null {
  if (row.pair_created_at_ms == null) return null;
  const ageMs = row.first_seen_ms - row.pair_created_at_ms;
  const ageMin = ageMs / 60000;
  if (ageMin < 30) return bucketUnder30;
  if (ageMin < 60) return bucket30To60;
  return bucketOver60;
}

for (const r of rows) {
  const first = r.first_price;
  const peak = r.max_price;
  const last = db
    .prepare(
      "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at DESC LIMIT 1"
    )
    .get(r.mint) as { price_usd: number } | undefined;
  const lastPrice = last ? last.price_usd : peak;

  const runup = (peak - first) / first;
  const giveback = (peak - lastPrice) / peak;
  const isRunner = runup >= 0.5;
  const isRoundtrip = isRunner && lastPrice <= first * 1.1;

  if (isRunner) runners++;
  if (isRoundtrip) roundtrips++;
  runups.push(runup);

  // Age bucket
  const bucket = classifyBucket(r);
  if (bucket) {
    bucket.n++;
    if (isRunner) bucket.runners++;
    if (isRoundtrip) bucket.roundtrips++;
    bucket.runups.push(runup);
  } else {
    bucketUnknown.n++;
    if (isRunner) bucketUnknown.runners++;
    if (isRoundtrip) bucketUnknown.roundtrips++;
    bucketUnknown.runups.push(runup);
  }

  // Skip mints with no first price
  if (first <= 0) continue;

  if (isRunner || isRoundtrip) {
    const fStr = first ? `$${first.toPrecision(4)}` : "?";
    const pStr = peak ? `$${peak.toPrecision(4)}` : "?";
    console.log(
      `${r.mint.slice(0, 8)}... ${r.tick_count} ticks ` +
      `first=${fStr} peak=${pStr} ` +
      `runup=${(runup * 100).toFixed(0)}% ` +
      `giveback=${(giveback * 100).toFixed(0)}% ` +
      (isRoundtrip ? "[ROUNDTRIP]" : "[RUNNER]")
    );
  }
}

runups.sort((a, b) => b - a);
const medianIdx = Math.floor(runups.length / 2);
const median = runups[medianIdx];

console.log(`\nrunners: ${runners}`);
console.log(`round-trips: ${roundtrips}`);
console.log(`median runup: ${(median * 100).toFixed(0)}%`);

function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => b - a);
  return arr[Math.floor(arr.length / 2)];
}

console.log(`\nby pair age at first tick:`);
console.log(
  `  <30m:  n=${bucketUnder30.n} runners=${bucketUnder30.runners} ` +
  `round-trips=${bucketUnder30.roundtrips} median=${(medianOf(bucketUnder30.runups) * 100).toFixed(0)}%`
);
console.log(
  `  30-60m: n=${bucket30To60.n} runners=${bucket30To60.runners} ` +
  `round-trips=${bucket30To60.roundtrips} median=${(medianOf(bucket30To60.runups) * 100).toFixed(0)}%`
);
console.log(
  `  >60m:  n=${bucketOver60.n} runners=${bucketOver60.runners} ` +
  `round-trips=${bucketOver60.roundtrips} median=${(medianOf(bucketOver60.runups) * 100).toFixed(0)}%`
);
console.log(
  `  age=?:  n=${bucketUnknown.n} runners=${bucketUnknown.runners} ` +
  `round-trips=${bucketUnknown.roundtrips} median=${(medianOf(bucketUnknown.runups) * 100).toFixed(0)}%`
);

// ===== Phase 13C: entry factors and exit analysis (under 30m bucket) =====

console.log(`\n=== entry factors (first tick, <30m bucket only) ===`);

// Collect first-tick factor values for <30m mints
type FirstTick = {
  mint: string;
  liq_usd: number | null;
  change_5m_pct: number | null;
  vol_5m_usd: number | null;
  tx_5m_sells: number | null;
  is_runner: boolean;
};

const youngMints = rows.filter((r) => {
  if (r.pair_created_at_ms == null) return false;
  const ageMs = r.first_seen_ms - r.pair_created_at_ms;
  return ageMs / 60000 < 30;
});

const firstTicks: FirstTick[] = youngMints.map((r) => {
  const tick = db
    .prepare(
      "SELECT price_usd, liq_usd, change_5m_pct, vol_5m_usd, tx_5m_sells FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC LIMIT 1"
    )
    .get(r.mint) as {
      price_usd: number;
      liq_usd: number | null;
      change_5m_pct: number | null;
      vol_5m_usd: number | null;
      tx_5m_sells: number | null;
    } | undefined;

  if (!tick) return null;

  const runup = (r.max_price - r.first_price) / r.first_price;
  return {
    mint: r.mint,
    liq_usd: tick.liq_usd,
    change_5m_pct: tick.change_5m_pct,
    vol_5m_usd: tick.vol_5m_usd,
    tx_5m_sells: tick.tx_5m_sells,
    is_runner: runup >= 0.5,
  };
}).filter((ft): ft is FirstTick => ft !== null);

console.log(`young mints analyzed: ${firstTicks.length}`);

// Entry factor: liquidity at first tick
function factorBucket(name: string, ticks: FirstTick[], getValue: (ft: FirstTick) => number | null, buckets: { label: string; test: (v: number) => boolean }[]) {
  console.log(`\nentry factor: ${name}`);
  for (const b of buckets) {
    const subset = ticks.filter((ft) => {
      const v = getValue(ft);
      return v !== null && b.test(v);
    });
    const runnerCount = subset.filter((ft) => ft.is_runner).length;
    const runnerRate = subset.length > 0 ? (runnerCount / subset.length) * 100 : 0;
    console.log(`  ${b.label}: n=${subset.length} runner rate=${runnerRate.toFixed(1)}%`);
  }
}

factorBucket("liq_usd", firstTicks, (ft) => ft.liq_usd, [
  { label: "<10k", test: (v) => v < 10000 },
  { label: "10k-50k", test: (v) => v >= 10000 && v < 50000 },
  { label: ">=50k", test: (v) => v >= 50000 },
]);

factorBucket("change_5m_pct", firstTicks, (ft) => ft.change_5m_pct, [
  { label: "<0", test: (v) => v < 0 },
  { label: "0-25", test: (v) => v >= 0 && v < 25 },
  { label: ">=25", test: (v) => v >= 25 },
]);

factorBucket("vol_5m_usd", firstTicks, (ft) => ft.vol_5m_usd, [
  { label: "<1k", test: (v) => v < 1000 },
  { label: "1k-10k", test: (v) => v >= 1000 && v < 10000 },
  { label: ">=10k", test: (v) => v >= 10000 },
]);

// tx_5m_sells: 0 vs >0
console.log(`\nentry factor: tx_5m_sells`);
for (const label of ["0", ">0"]) {
  const subset = firstTicks.filter((ft) => {
    if (ft.tx_5m_sells === null) return false;
    if (label === "0") return ft.tx_5m_sells === 0;
    return ft.tx_5m_sells > 0;
  });
  const runnerCount = subset.filter((ft) => ft.is_runner).length;
  const runnerRate = subset.length > 0 ? (runnerCount / subset.length) * 100 : 0;
  console.log(`  ${label}: n=${subset.length} runner rate=${runnerRate.toFixed(1)}%`);
}

// ===== Exit analysis: walk ticks and evaluate take-profit levels =====

console.log(`\n=== exit analysis (<30m bucket only) ===`);

// Runup thresholds to check
const runupLevels = [0.30, 0.50, 1.00, 2.00];

for (const level of runupLevels) {
  let hitCount = 0;
  for (const r of youngMints) {
    const runup = (r.max_price - r.first_price) / r.first_price;
    if (runup >= level) hitCount++;
  }
  const hitPct = youngMints.length > 0 ? (hitCount / youngMints.length) * 100 : 0;
  console.log(`reached ${level * 100}% runup: ${hitCount}/${youngMints.length} (${hitPct.toFixed(1)}%)`);
}

// Evaluate exit policies: 30% TP, 50% TP, 100% TP, hold
console.log(`\nexit policy evaluation:`);

type ExitPolicy = { label: string; threshold: number | null };
const policies: ExitPolicy[] = [
  { label: "tp=30%", threshold: 0.30 },
  { label: "tp=50%", threshold: 0.50 },
  { label: "tp=100%", threshold: 1.00 },
  { label: "hold", threshold: null },
];

for (const policy of policies) {
  const returns: number[] = [];

  for (const r of youngMints) {
    // Walk ticks chronologically to find exit price
    const ticks = db
      .prepare("SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC")
      .all(r.mint) as { price_usd: number }[];

    if (ticks.length === 0) continue;

    const firstPrice = ticks[0].price_usd;
    if (firstPrice <= 0) continue;
    let exitPrice: number;

    if (policy.threshold !== null) {
      // Find first tick at or above threshold
      let found = false;
      for (const tick of ticks) {
        const runup = (tick.price_usd - firstPrice) / firstPrice;
        if (runup >= policy.threshold) {
          exitPrice = tick.price_usd;
          found = true;
          break;
        }
      }
      if (!found) {
        // Never hit threshold; exit at last tick
        exitPrice = ticks[ticks.length - 1].price_usd;
      }
    } else {
      // Hold: exit at last tick
      exitPrice = ticks[ticks.length - 1].price_usd;
    }

    const ret = exitPrice / firstPrice - 1;
    returns.push(ret);
  }

  if (returns.length === 0) {
    console.log(`  ${policy.label}: n=0`);
    continue;
  }

  // How many hit the TP cap (if policy has threshold)
  let hitCap = 0;
  if (policy.threshold !== null) {
    for (const ret of returns) {
      if (ret >= policy.threshold) hitCap++;
    }
  }

  returns.sort((a, b) => a - b);
  const medianRet = returns[Math.floor(returns.length / 2)];
  const sumRet = returns.reduce((a, b) => a + b, 0);

  if (policy.threshold !== null) {
    console.log(`  ${policy.label}: n=${returns.length} hit_cap=${hitCap} median_ret=${(medianRet * 100).toFixed(1)}% sum_ret=${(sumRet * 100).toFixed(1)}%`);
  } else {
    console.log(`  ${policy.label}: n=${returns.length} median_ret=${(medianRet * 100).toFixed(1)}% sum_ret=${(sumRet * 100).toFixed(1)}%`);
  }
}

db.close();