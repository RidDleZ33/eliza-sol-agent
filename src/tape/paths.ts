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
  first_seen: string;
  last_seen: string;
  first_price: number;
  max_price: number;
  min_price: number;
  first_liq: number;
};

// Per-mint path stats: first tick price, peak, trough, liquidity at first
const rows = db
  .prepare(`
    SELECT
      mint,
      COUNT(*) AS tick_count,
      MIN(observed_at) AS first_seen,
      MAX(observed_at) AS last_seen,
      (SELECT price_usd FROM market_ticks t2
       WHERE t2.mint = t1.mint ORDER BY t2.observed_at ASC LIMIT 1) AS first_price,
      MAX(price_usd) AS max_price,
      MIN(price_usd) AS min_price,
      (SELECT liq_usd FROM market_ticks t3
       WHERE t3.mint = t1.mint ORDER BY t3.observed_at ASC LIMIT 1) AS first_liq
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

db.close();
