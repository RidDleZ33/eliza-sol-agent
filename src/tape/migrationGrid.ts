// Migration exit policy grid.
// Scores 15 exit policies on each scored mint, plus bucketed breakdowns.
// Same clock, entry, and window rules as migrations.ts.
// Clock: earliest pair_created_at_ms across day files.
// Entry: first market_ticks row at or after clock + 5 minutes with price_usd > 0.
// Window: 60 minutes from the entry tick's observed_at_ms.

import { existsSync, readdirSync } from "fs";
import Database from "better-sqlite3";

const TAPE_DIR = "data/tape";

function dateFromFilename(name: string): string | null {
  if (!name.startsWith("tape-") || !name.endsWith(".sqlite") || name.length !== 22) {
    return null;
  }
  const datePart = name.slice(5, 15);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return datePart;
  }
  return null;
}

function openReadOnly(path: string) {
  return new Database(path, { readonly: true });
}

interface MigrationClockInfo {
  clockMs: number;
  rawJson: string | null;
}

function collectMigrationClocks(): Map<string, MigrationClockInfo> {
  const clocks = new Map<string, MigrationClockInfo>();

  if (!existsSync(TAPE_DIR)) {
    console.log("data/tape not found");
    return clocks;
  }

  const files = readdirSync(TAPE_DIR);

  for (const f of files) {
    if (f === "tape.sqlite") continue;
    const datePart = dateFromFilename(f);
    if (!datePart) continue;

    const path = `${TAPE_DIR}/${f}`;
    let db: Database;
    try {
      db = openReadOnly(path);
    } catch (e: any) {
      console.log(`[migration-grid] cannot open ${f}: ${e.message}`);
      continue;
    }

    try {
      const rows: any[] = db
        .prepare(
          "SELECT mint, pair_address, pair_created_at_ms, raw_json FROM migrations ORDER BY observed_at_ms ASC"
        )
        .all();
      for (const row of rows) {
        if (row.pair_created_at_ms == null) continue;
        const existing = clocks.get(row.mint);
        if (
          existing === undefined ||
          row.pair_created_at_ms < existing.clockMs
        ) {
          clocks.set(row.mint, {
            clockMs: row.pair_created_at_ms,
            rawJson: row.raw_json,
          });
        }
      }
    } catch (e: any) {
      console.log(`[migration-grid] query failed on ${f}: ${e.message}`);
    }

    db.close();
  }

  return clocks;
}

interface Tick {
  mint: string;
  price_usd: number;
  observed_at_ms: number;
  liq_usd: number;
  tx_5m_buys: number;
  tx_5m_sells: number;
}

function getTicksForMint(mint: string, clockMs: number) {
  if (!existsSync(TAPE_DIR)) {
    return { entry: null as Tick | null, ticks: [] as Tick[] };
  }

  const files = readdirSync(TAPE_DIR);
  let entryTick: Tick | null = null;
  let entryObserved = Infinity;
  let allTicks: Tick[] = [];

  for (const f of files) {
    if (f === "tape.sqlite") continue;
    const datePart = dateFromFilename(f);
    if (!datePart) continue;

    const path = `${TAPE_DIR}/${f}`;
    let db: Database;
    try {
      db = openReadOnly(path);
    } catch {
      continue;
    }

    const entryAfterMs = clockMs + 5 * 60 * 1000;

    const potentialEntries: Tick[] = db
      .prepare(
        "SELECT mint, price_usd, observed_at_ms, liq_usd, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND observed_at_ms >= ? ORDER BY observed_at_ms ASC LIMIT 1"
      )
      .all(mint, entryAfterMs);

    if (potentialEntries.length > 0) {
      const candidate = potentialEntries[0];
      if (candidate.price_usd > 0 && candidate.observed_at_ms < entryObserved) {
        entryObserved = candidate.observed_at_ms;
        entryTick = candidate;
      }
    }

    const ticks: Tick[] = db
      .prepare(
        "SELECT mint, price_usd, observed_at_ms, liq_usd, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND observed_at_ms > ? ORDER BY observed_at_ms ASC"
      )
      .all(mint, entryAfterMs);

    allTicks = allTicks.concat(ticks);

    db.close();
  }

  allTicks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);

  let windowTicks: Tick[] = [];
  if (entryTick !== null) {
    const windowEnd = entryTick.observed_at_ms + 60 * 60 * 1000;
    for (const t of allTicks) {
      if (t.observed_at_ms <= windowEnd) {
        windowTicks.push(t);
      } else {
        break;
      }
    }
  }

  return { entry: entryTick, ticks: windowTicks };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// Policy scoring functions

interface PolicyResult {
  return: number;
  hit: boolean;
}

function scoreFlat(ticks: Tick[], entryPrice: number, level: number, lastPrice: number): PolicyResult {
  for (const tick of ticks) {
    if (tick.price_usd >= entryPrice * level) {
      return { return: tick.price_usd / entryPrice - 1, hit: true };
    }
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

function scoreTrail(ticks: Tick[], entryPrice: number, trail: number, lastPrice: number): PolicyResult {
  const armLevel = entryPrice * 1.15;
  let armed = false;
  let peak = entryPrice;
  for (const tick of ticks) {
    if (!armed && tick.price_usd >= armLevel) {
      armed = true;
      peak = tick.price_usd;
    } else if (armed) {
      if (tick.price_usd > peak) peak = tick.price_usd;
      if (tick.price_usd <= peak * (1 - trail)) {
        return { return: tick.price_usd / entryPrice - 1, hit: true };
      }
    }
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

function scoreHalfTrail(ticks: Tick[], entryPrice: number, halfLevel: number, trail: number, lastPrice: number): PolicyResult {
  const halfArmLevel = entryPrice * halfLevel;
  let halfSold = false;
  let halfReturn = 0;
  let secondPeak = 0;
  for (const tick of ticks) {
    if (!halfSold) {
      if (tick.price_usd >= halfArmLevel) {
        halfSold = true;
        halfReturn = tick.price_usd / entryPrice - 1;
        secondPeak = tick.price_usd;
      }
    } else {
      if (tick.price_usd > secondPeak) secondPeak = tick.price_usd;
      if (tick.price_usd <= secondPeak * (1 - trail)) {
        const trailReturn = tick.price_usd / entryPrice - 1;
        return { return: (halfReturn + trailReturn) / 2, hit: true };
      }
      if (tick.price_usd <= entryPrice) {
        const beReturn = tick.price_usd / entryPrice - 1;
        return { return: (halfReturn + beReturn) / 2, hit: true };
      }
    }
  }
  const finalReturn = lastPrice / entryPrice - 1;
  if (halfSold) {
    return { return: (halfReturn + finalReturn) / 2, hit: true };
  }
  return { return: finalReturn, hit: false };
}

function scoreFlatOrClock(ticks: Tick[], entryTick: Tick, entryPrice: number, level: number, clockMinutes: number, lastPrice: number): PolicyResult {
  const clockMs = entryTick.observed_at_ms + clockMinutes * 60 * 1000;
  let lastBeforeClock = null;
  for (const tick of ticks) {
    if (tick.price_usd >= entryPrice * level) {
      return { return: tick.price_usd / entryPrice - 1, hit: true };
    }
    if (tick.observed_at_ms >= clockMs) {
      if (lastBeforeClock !== null) {
        return { return: lastBeforeClock.price_usd / entryPrice - 1, hit: false };
      }
      return { return: tick.price_usd / entryPrice - 1, hit: false };
    }
    lastBeforeClock = tick;
  }
  if (lastBeforeClock !== null) {
    return { return: lastBeforeClock.price_usd / entryPrice - 1, hit: false };
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

function scoreFlatOrStop(ticks: Tick[], entryPrice: number, profitLevel: number, stopLevel: number, lastPrice: number): PolicyResult {
  for (const tick of ticks) {
    if (tick.price_usd >= entryPrice * profitLevel) {
      return { return: tick.price_usd / entryPrice - 1, hit: true };
    }
    if (tick.price_usd <= entryPrice * (1 - stopLevel)) {
      return { return: tick.price_usd / entryPrice - 1, hit: false };
    }
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

interface Policy {
  name: string;
  fn: (ticks: Tick[], entryTick: Tick, entryPrice: number, lastPrice: number) => PolicyResult;
}

const POLICIES: Policy[] = [
  { name: "flat20", fn: (t, e, ep, lp) => scoreFlat(t, ep, 1.2, lp) },
  { name: "flat30", fn: (t, e, ep, lp) => scoreFlat(t, ep, 1.3, lp) },
  { name: "flat40", fn: (t, e, ep, lp) => scoreFlat(t, ep, 1.4, lp) },
  { name: "flat50", fn: (t, e, ep, lp) => scoreFlat(t, ep, 1.5, lp) },
  { name: "hold", fn: (t, e, ep, lp) => ({ return: lp / ep - 1, hit: false }) },
  { name: "trail10", fn: (t, e, ep, lp) => scoreTrail(t, ep, 0.1, lp) },
  { name: "trail15", fn: (t, e, ep, lp) => scoreTrail(t, ep, 0.15, lp) },
  { name: "trail20", fn: (t, e, ep, lp) => scoreTrail(t, ep, 0.2, lp) },
  { name: "trail25", fn: (t, e, ep, lp) => scoreTrail(t, ep, 0.25, lp) },
  { name: "half30trail20", fn: (t, e, ep, lp) => scoreHalfTrail(t, ep, 1.3, 0.2, lp) },
  { name: "half40trail15", fn: (t, e, ep, lp) => scoreHalfTrail(t, ep, 1.4, 0.15, lp) },
  { name: "flat30or15m", fn: (t, e, ep, lp) => scoreFlatOrClock(t, e, ep, 1.3, 15, lp) },
  { name: "flat30or30m", fn: (t, e, ep, lp) => scoreFlatOrClock(t, e, ep, 1.3, 30, lp) },
  { name: "flat30stop20", fn: (t, e, ep, lp) => scoreFlatOrStop(t, ep, 1.3, 0.2, lp) },
  { name: "flat30stop25", fn: (t, e, ep, lp) => scoreFlatOrStop(t, ep, 1.3, 0.25, lp) },
];

// Bucket functions

function parseMigration(rawJson: string | null): any {
  if (!rawJson) return null;
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

function bucketLabel(field: string, value: any): string {
  if (field === "liq_usd") {
    if (value < 25000) return "<25k";
    if (value < 50000) return "25-50k";
    if (value < 100000) return "50-100k";
    return ">=100k";
  }
  if (field === "usd_market_cap") {
    if (value < 30000) return "<30k";
    if (value < 80000) return "30-80k";
    return ">=80k";
  }
  if (field === "buySell") {
    if (value < 1) return "<1";
    if (value < 2) return "1-2";
    return ">=2";
  }
  if (field === "top_10_holder_rate") {
    if (value < 0.2) return "<0.2";
    if (value < 0.4) return "0.2-0.4";
    return ">=0.4";
  }
  if (field === "bundler_trader_amount_rate") {
    if (value < 0.1) return "<0.1";
    if (value < 0.3) return "0.1-0.3";
    return ">=0.3";
  }
  if (field === "rat_trader_amount_rate") {
    if (value < 0.1) return "<0.1";
    if (value < 0.3) return "0.1-0.3";
    return ">=0.3";
  }
  if (field === "sniper_count") {
    if (value === 0) return "0";
    if (value <= 10) return "1-10";
    return ">10";
  }
  if (field === "holder_count") {
    if (value < 100) return "<100";
    if (value < 500) return "100-500";
    return ">=500";
  }
  if (field === "smart_degen_count") {
    if (value === 0) return "0";
    return ">=1";
  }
  if (field === "renowned_count") {
    if (value === 0) return "0";
    return ">=1";
  }
  if (field === "creator_token_status") {
    if (value === "creator_hold") return "creator_hold";
    if (value === "creator_close") return "creator_close";
    return "other";
  }
  if (field === "dev_team_hold_rate") {
    if (value < 0.05) return "<0.05";
    return ">=0.05";
  }
  if (field === "complete_cost_time") {
    if (value < 300) return "<300s";
    if (value < 1800) return "300-1800s";
    return ">=1800s";
  }
  if (field === "has_at_least_one_social") {
    if (value === true) return "true";
    if (value === false) return "false";
    return "unknown";
  }
  if (field === "is_wash_trading") {
    if (value === true) return "true";
    if (value === false) return "false";
    return "unknown";
  }
  if (field === "rug_ratio") {
    if (value < 0.3) return "<0.3";
    return ">=0.3";
  }
  return "unknown";
}

function main() {
  console.log("[migration-grid] collecting migration clocks...");
  const clocks = collectMigrationClocks();
  console.log(`[migration-grid] ${clocks.size} mints with migration clocks`);

  if (clocks.size === 0) {
    console.log("[migration-grid] no migration data found");
    return;
  }

  // Score every mint on every policy
  const policyResults: Record<string, { returns: number[]; hits: number }> = {};
  for (const p of POLICIES) {
    policyResults[p.name] = { returns: [], hits: 0 };
  }

  let scored = 0;
  let unscored = 0;

  // Per-mint policy returns for bucketing
  const mintData: {
    mint: string;
    rawJson: string | null;
    results: Record<string, PolicyResult>;
  }[] = [];

  let i = 0;
  for (const [mint, clockInfo] of clocks.entries()) {
    i++;
    if (i % 50 === 0) {
      console.log(`[migration-grid] ${i}/${clocks.size}...`);
    }

    const { entry, ticks } = getTicksForMint(mint, clockInfo.clockMs);

    if (entry === null || ticks.length === 0) {
      unscored++;
      continue;
    }

    scored++;
    const entryPrice = entry.price_usd;
    const lastPrice = ticks[ticks.length - 1].price_usd;

    const results: Record<string, PolicyResult> = {};
    for (const p of POLICIES) {
      results[p.name] = p.fn(ticks, entry, entryPrice, lastPrice);
      policyResults[p.name].returns.push(results[p.name].return);
      if (results[p.name].hit) {
        policyResults[p.name].hits++;
      }
    }

    mintData.push({ mint, rawJson: clockInfo.rawJson, results });
  }

  console.log(`\nScored: ${scored}`);
  console.log(`Unscored: ${unscored}`);

  // Overall table
  console.log("\n=== Overall ===");
  for (const p of POLICIES) {
    const pr = policyResults[p.name];
    if (pr.returns.length === 0) {
      console.log(`${p.name}: n=0`);
      continue;
    }
    const med = median(pr.returns);
    const avg = pr.returns.reduce((a, b) => a + b, 0) / pr.returns.length;
    if (p.name === "hold") {
      console.log(`${p.name}: n=${pr.returns.length} median=${(med * 100).toFixed(1)}% avg=${(avg * 100).toFixed(1)}%`);
    } else {
      const hitRate = (pr.hits / pr.returns.length) * 100;
      console.log(`${p.name}: n=${pr.returns.length} hit=${hitRate.toFixed(1)}% median=${(med * 100).toFixed(1)}% avg=${(avg * 100).toFixed(1)}%`);
    }
  }

  // Bucketed breakdowns per policy
  const bucketFields = [
    "liq_usd",
    "usd_market_cap",
    "buySell",
    "top_10_holder_rate",
    "bundler_trader_amount_rate",
    "rat_trader_amount_rate",
    "sniper_count",
    "holder_count",
    "smart_degen_count",
    "renowned_count",
    "creator_token_status",
    "dev_team_hold_rate",
    "complete_cost_time",
    "has_at_least_one_social",
    "is_wash_trading",
    "rug_ratio",
  ];

  // Track best buckets for summary
  const bestByField: Record<string, { name: string; policy: string; n: number; median: number }> = {};

  for (const policy of POLICIES) {
    console.log(`\n--- ${policy.name} buckets ---`);

    for (const field of bucketFields) {
      const buckets: Record<string, { returns: number[]; hits: number }> = {};

      for (const md of mintData) {
        const parsed = parseMigration(md.rawJson);
        if (!parsed) continue;

        let value: any;
        if (field === "buySell") {
          if (parsed.tx_5m_sells > 0) {
            value = parsed.tx_5m_buys / parsed.tx_5m_sells;
          } else {
            continue;
          }
        } else {
          value = parsed[field];
        }

        if (value === undefined || value === null) continue;

        const label = bucketLabel(field, value);
        const key = `${field}:${label}`;
        if (!buckets[key]) {
          buckets[key] = { returns: [], hits: 0 };
        }

        buckets[key].returns.push(md.results[policy.name].return);
        if (md.results[policy.name].hit) {
          buckets[key].hits++;
        }
      }

      // Print buckets with n >= 30
      for (const [key, data] of Object.entries(buckets)) {
        if (data.returns.length < 30) continue;

        const med = median(data.returns);
        const avg = data.returns.reduce((a, b) => a + b, 0) / data.returns.length;
        const hitRate = policy.name === "hold" ? 0 : (data.hits / data.returns.length) * 100;

        if (policy.name === "hold") {
          console.log(`${key} n=${data.returns.length} median=${(med * 100).toFixed(1)}% avg=${(avg * 100).toFixed(1)}%`);
        } else {
          console.log(`${key} n=${data.returns.length} hit=${hitRate.toFixed(1)}% median=${(med * 100).toFixed(1)}% avg=${(avg * 100).toFixed(1)}%`);
        }

        // Track best for summary
        if (!bestByField[field] || med > bestByField[field].median) {
          bestByField[field] = { name: key, policy: policy.name, n: data.returns.length, median: med };
        }
      }
    }
  }

  // Best flat30 bucket summary
  console.log("\n=== Best flat30 bucket ===");
  let bestFlat30 = null;
  for (const [key, data] of Object.entries(bestByField)) {
    if (data.policy === "flat30") {
      if (!bestFlat30 || data.median > bestFlat30.median) {
        bestFlat30 = data;
      }
    }
  }
  if (bestFlat30) {
    console.log(`best flat30 bucket: ${bestFlat30.name} n=${bestFlat30.n} median=${(bestFlat30.median * 100).toFixed(1)}%`);
  } else {
    console.log("best flat30 bucket: none found with n>=30");
  }

  // Best trail bucket summary
  console.log("\n=== Best trail bucket ===");
  let bestTrail = null;
  for (const [key, data] of Object.entries(bestByField)) {
    if (data.policy.startsWith("trail") || data.policy.startsWith("half")) {
      if (!bestTrail || data.median > bestTrail.median) {
        bestTrail = data;
      }
    }
  }
  if (bestTrail) {
    console.log(`best trail: ${bestTrail.name} n=${bestTrail.n} median=${(bestTrail.median * 100).toFixed(1)}%`);
  } else {
    console.log("best trail: none found with n>=30");
  }
}

main();