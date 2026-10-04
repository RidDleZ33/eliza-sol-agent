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

db.close();
