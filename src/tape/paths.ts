// Tape path report: per-mint runup/giveback analysis
// Usage: bun src/tape/paths.ts
// Read-only. Never writes to the tape.
// Reads all day files in the retention window + legacy file.

import { existsSync } from "fs";
import { discoverTapeFiles } from "./filelist";

const Database = require("better-sqlite3");

const files = discoverTapeFiles(true);

if (files.length === 0) {
  console.log("no tape files found; run `bun run tape` first");
  process.exit(0);
}

console.log(`reading ${files.length} tape file(s)`);

// Open all files as readonly
const dbs = files.map((f) => {
  const db = new Database(f.path, { readonly: true });
  db.pragma("cache_size = -64000");
  return { db, path: f.path };
});

// Query helper: run a statement across all open DBs, collecting results
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

// Query one row from any DB that has it (for last price lookup)
function queryFirst<T>(sql: string, params: any[] = []): T | undefined {
  for (const { db } of dbs) {
    try {
      const row = db.prepare(sql).get(...params) as T | undefined;
      if (row) return row;
    } catch {
      // ignore
    }
  }
  return undefined;
}

type PathRow = {
  mint: string;
  tick_count: number;
  first_seen_ms: number;
  pair_created_at_ms: number | null;
  first_price: number;
  max_price: number;
};

// Collect all per-mint path stats across files
const allRows = queryAll<PathRow>(`
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
`);

// Dedup by mint, keeping earliest first_seen_ms
const byMint = new Map<string, PathRow>();
for (const row of allRows) {
  const existing = byMint.get(row.mint);
  if (!existing || row.first_seen_ms < existing.first_seen_ms) {
    byMint.set(row.mint, row);
  }
}
const rows = Array.from(byMint.values());

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
  const last = queryFirst<{ price_usd: number }>(
    "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at DESC LIMIT 1",
    [r.mint]
  );
  const lastPrice = last ? last.price_usd : r.max_price;

  const runup = (r.max_price - r.first_price) / r.first_price;
  const giveback = (r.max_price - lastPrice) / r.max_price;
  const isRunner = runup >= 0.5;
  const isRoundtrip = isRunner && lastPrice <= r.first_price * 1.1;

  if (isRunner) runners++;
  if (isRoundtrip) roundtrips++;
  runups.push(runup);

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

  if (r.first_price <= 0) continue;

  if (isRunner || isRoundtrip) {
    const fStr = `$${r.first_price.toPrecision(4)}`;
    const pStr = `$${r.max_price.toPrecision(4)}`;
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
  const tick = queryFirst<{
    price_usd: number;
    liq_usd: number | null;
    change_5m_pct: number | null;
    vol_5m_usd: number | null;
    tx_5m_sells: number | null;
  }>(
    "SELECT price_usd, liq_usd, change_5m_pct, vol_5m_usd, tx_5m_sells FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC LIMIT 1",
    [r.mint]
  );

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
    const ticks = queryAll<{ price_usd: number }>(
      "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC",
      [r.mint]
    );

    if (ticks.length === 0) continue;

    const firstPrice = ticks[0].price_usd;
    if (firstPrice <= 0) continue;
    let exitPrice: number;

    if (policy.threshold !== null) {
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
        exitPrice = ticks[ticks.length - 1].price_usd;
      }
    } else {
      exitPrice = ticks[ticks.length - 1].price_usd;
    }

    const ret = exitPrice / firstPrice - 1;
    returns.push(ret);
  }

  if (returns.length === 0) {
    console.log(`  ${policy.label}: n=0`);
    continue;
  }

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

// ===== Phase 13D: scale-out exits (under 30m bucket) =====

console.log(`\n=== scale-out exits (<30m bucket only) ===`);

{
  const returns: number[] = [];
  for (const r of youngMints) {
    const ticks = queryAll<{ price_usd: number }>(
      "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC",
      [r.mint]
    );
    if (ticks.length === 0) continue;
    const firstPrice = ticks[0].price_usd;
    if (firstPrice <= 0) continue;
    let exitPrice = ticks[ticks.length - 1].price_usd;
    for (const tick of ticks) {
      if (tick.price_usd >= firstPrice * 1.3) {
        exitPrice = tick.price_usd;
        break;
      }
    }
    returns.push(exitPrice / firstPrice - 1);
  }
  returns.sort((a, b) => a - b);
  const medianRet = returns[Math.floor(returns.length / 2)];
  const sumRet = returns.reduce((a, b) => a + b, 0);
  console.log(`  sell-all-1.3x: n=${returns.length} median_ret=${(medianRet * 100).toFixed(1)}% sum_ret=${(sumRet * 100).toFixed(1)}%`);
}

{
  const returns: number[] = [];
  for (const r of youngMints) {
    const ticks = queryAll<{ price_usd: number }>(
      "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC",
      [r.mint]
    );
    if (ticks.length === 0) continue;
    const firstPrice = ticks[0].price_usd;
    if (firstPrice <= 0) continue;
    let exitPrice1 = ticks[ticks.length - 1].price_usd;
    let exitPrice2 = ticks[ticks.length - 1].price_usd;
    let found1 = false;
    for (const tick of ticks) {
      if (!found1 && tick.price_usd >= firstPrice * 1.3) {
        exitPrice1 = tick.price_usd;
        found1 = true;
      }
      if (tick.price_usd >= firstPrice * 2.0) {
        exitPrice2 = tick.price_usd;
        break;
      }
    }
    const proceeds = 0.5 * exitPrice1 + 0.5 * exitPrice2;
    returns.push(proceeds / firstPrice - 1);
  }
  returns.sort((a, b) => a - b);
  const medianRet = returns[Math.floor(returns.length / 2)];
  const sumRet = returns.reduce((a, b) => a + b, 0);
  console.log(`  half-1.3x-half-2x: n=${returns.length} median_ret=${(medianRet * 100).toFixed(1)}% sum_ret=${(sumRet * 100).toFixed(1)}%`);
}

{
  const returns: number[] = [];
  for (const r of youngMints) {
    const ticks = queryAll<{ price_usd: number }>(
      "SELECT price_usd FROM market_ticks WHERE mint = ? ORDER BY observed_at ASC",
      [r.mint]
    );
    if (ticks.length === 0) continue;
    const firstPrice = ticks[0].price_usd;
    if (firstPrice <= 0) continue;
    let exitPrice1 = ticks[ticks.length - 1].price_usd;
    let exitPrice2 = ticks[ticks.length - 1].price_usd;
    let found1 = false;
    let maxAfter = 0;
    for (const tick of ticks) {
      if (!found1 && tick.price_usd >= firstPrice * 1.3) {
        exitPrice1 = tick.price_usd;
        found1 = true;
      }
      if (found1) {
        if (tick.price_usd > maxAfter) {
          maxAfter = tick.price_usd;
        }
        if (tick.price_usd <= maxAfter * 0.8) {
          exitPrice2 = tick.price_usd;
          break;
        }
      }
    }
    const proceeds = 0.5 * exitPrice1 + 0.5 * exitPrice2;
    returns.push(proceeds / firstPrice - 1);
  }
  returns.sort((a, b) => a - b);
  const medianRet = returns[Math.floor(returns.length / 2)];
  const sumRet = returns.reduce((a, b) => a + b, 0);
  console.log(`  half-1.3x-half-20pct-drawdown: n=${returns.length} median_ret=${(medianRet * 100).toFixed(1)}% sum_ret=${(sumRet * 100).toFixed(1)}%`);
}

for (const { db } of dbs) {
  db.close();
}