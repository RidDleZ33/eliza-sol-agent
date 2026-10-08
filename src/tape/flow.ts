// Tape flow split: how do flow features move, and print the two labels
// Read-only. Never writes to the tape.
// Universe: first tick < 60min after pair_created_at_ms, liq_usd >= 10000, price > 0
// Hit: later tick at or above 1.3x the first price
// Splits: liq rose >=20% before hit, buy share rose over next 3 ticks, boost_active, has_socials
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

function getMints() {
  return queryAll<{ mint: string; first_tick_ms: number }>(
    "SELECT mint, MIN(observed_at_ms) as first_tick_ms FROM market_ticks GROUP BY mint"
  );
}

function getTicks(mint: string) {
  return queryAll<{
    observed_at_ms: number;
    price_usd: number | null;
    liq_usd: number | null;
    pair_created_at_ms: number | null;
    tx_5m_buys: number | null;
    tx_5m_sells: number | null;
    boost_active: number | null;
    has_socials: number | null;
  }>(
    "SELECT observed_at_ms, price_usd, liq_usd, pair_created_at_ms, tx_5m_buys, tx_5m_sells, boost_active, has_socials FROM market_ticks WHERE mint = ? ORDER BY observed_at_ms ASC",
    [mint]
  );
}

function buyShare(buys: number | null, sells: number | null): number | null {
  if (buys == null || sells == null) return null;
  const total = buys + sells;
  if (total === 0) return null;
  return buys / total;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s[mid];
}

function evalMint(mint: string) {
  const ticks = getTicks(mint);
  if (ticks.length < 1) return null;

  const t0 = ticks[0];
  if (t0.price_usd == null || t0.price_usd <= 0) return null;
  if (t0.liq_usd == null || t0.liq_usd < 10000) return null;

  // First tick within 60 min of pair creation
  if (t0.pair_created_at_ms != null) {
    const ageMs = t0.observed_at_ms - t0.pair_created_at_ms;
    if (ageMs >= 60 * 60000) return null;
  }

  // Find hit: later tick at or above 1.3x first price
  let hit = false;
  let hitIdx = -1;
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].price_usd != null && ticks[i].price_usd >= t0.price_usd * 1.3) {
      hit = true;
      hitIdx = i;
      break;
    }
  }
  const lastTick = ticks[ticks.length - 1];
  const hold = lastTick.price_usd != null ? (lastTick.price_usd / t0.price_usd - 1) * 100 : 0;

  // Split 1: liq rose >=20% before hit (miss: liq at last tick)
  let liqRose = false;
  const targetLiq = t0.liq_usd * 1.2;
  if (hit && hitIdx > 0) {
    for (let i = 1; i <= hitIdx; i++) {
      if (ticks[i].liq_usd != null && ticks[i].liq_usd >= targetLiq) {
        liqRose = true;
        break;
      }
    }
  } else {
    if (lastTick.liq_usd != null && lastTick.liq_usd >= targetLiq) {
      liqRose = true;
    }
  }

  // Split 2: buy share rose over next three ticks vs fell/flat
  let shares: number[] = [];
  const s0 = buyShare(t0.tx_5m_buys, t0.tx_5m_sells);
  if (s0 != null) shares.push(s0);
  let collected = 0;
  for (let i = 1; i < ticks.length && collected < 3; i++) {
    const s = buyShare(ticks[i].tx_5m_buys, ticks[i].tx_5m_sells);
    if (s != null) {
      shares.push(s);
      collected++;
    }
  }
  let buyShareRose = false;
  if (shares.length >= 2) {
    buyShareRose = shares[shares.length - 1] > shares[0];
  }

  // Split 3: boost_active and has_socials at first tick
  const boost = t0.boost_active != null && t0.boost_active === 1;
  const socials = t0.has_socials != null && t0.has_socials === 1;

  return {
    hit,
    hold,
    liqRose,
    buyShareRose,
    boost,
    socials,
  };
}

const mintRows = getMints();
mintRows.sort((a, b) => a.first_tick_ms - b.first_tick_ms);

const split = Math.floor(mintRows.length * 0.8);
const trainMints = mintRows.slice(0, split).map((r) => r.mint);
const holdoutMints = mintRows.slice(split).map((r) => r.mint);

console.log(`mints: total=${mintRows.length} train=${trainMints.length} holdout=${holdoutMints.length}`);

function report(label: string, results: { hit: boolean; hold: number }[]) {
  if (results.length === 0) {
    console.log(`  ${label}: n=0`);
    return;
  }
  const hitCount = results.filter((r) => r.hit).length;
  const hitRate = (hitCount / results.length) * 100;
  const holdMed = median(results.map((r) => r.hold));
  console.log(`  ${label}: n=${results.length} hit=${hitCount} (${hitRate.toFixed(1)}%) hold_med=${holdMed.toFixed(1)}p`);
}

// Split 1: liquidity rose
for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]] as const) {
  const rose: { hit: boolean; hold: number }[] = [];
  const flat: { hit: boolean; hold: number }[] = [];
  for (const mint of mints) {
    const r = evalMint(mint);
    if (r == null) continue;
    if (r.liqRose) rose.push({ hit: r.hit, hold: r.hold });
    else flat.push({ hit: r.hit, hold: r.hold });
  }
  console.log(`${splitName} liquidity rose >=20%:`);
  report("rose", rose);
  report("flat", flat);
}

// Split 2: buy share rose
for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]] as const) {
  const rose: { hit: boolean; hold: number }[] = [];
  const flat: { hit: boolean; hold: number }[] = [];
  for (const mint of mints) {
    const r = evalMint(mint);
    if (r == null) continue;
    if (r.buyShareRose) rose.push({ hit: r.hit, hold: r.hold });
    else flat.push({ hit: r.hit, hold: r.hold });
  }
  console.log(`${splitName} buy share rose:`);
  report("rose", rose);
  report("flat", flat);
}

// Split 3: boost and socials
for (const [splitName, mints] of [["train", trainMints], ["holdout", holdoutMints]] as const) {
  const boostYes: { hit: boolean; hold: number }[] = [];
  const boostNo: { hit: boolean; hold: number }[] = [];
  const socYes: { hit: boolean; hold: number }[] = [];
  const socNo: { hit: boolean; hold: number }[] = [];
  for (const mint of mints) {
    const r = evalMint(mint);
    if (r == null) continue;
    if (r.boost) boostYes.push({ hit: r.hit, hold: r.hold });
    else boostNo.push({ hit: r.hit, hold: r.hold });
    if (r.socials) socYes.push({ hit: r.hit, hold: r.hold });
    else socNo.push({ hit: r.hit, hold: r.hold });
  }
  console.log(`${splitName} boost_active:`);
  report("yes", boostYes);
  report("no", boostNo);
  console.log(`${splitName} has_socials:`);
  report("yes", socYes);
  report("no", socNo);
}

for (const { db } of dbs) {
  db.close();
}