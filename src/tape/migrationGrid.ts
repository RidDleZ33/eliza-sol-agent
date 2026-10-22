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
  pairAddress: string | null;
  rawJson: string | null;
  nukeRatio: number | null;
  top5Ratio: number | null;
  sameSlotBuyers: number | null;
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
    let needsColumns = false;
    try {
      db = openReadOnly(path);
    } catch (e: any) {
      console.log(`[migration-grid] cannot open ${f}: ${e.message}`);
      continue;
    }

    try {
      let query = "SELECT mint, pair_address, pair_created_at_ms, raw_json";
      // Check if nuke_ratio column exists on this day file
      try {
        db.prepare("SELECT nuke_ratio FROM migrations LIMIT 0").get();
        query += ", nuke_ratio";
      } catch {
        // column doesn't exist on this day file
      }
      // Check if top5_ratio column exists on this day file
      try {
        db.prepare("SELECT top5_ratio FROM migrations LIMIT 0").get();
        query += ", top5_ratio";
      } catch {
        // column doesn't exist on this day file
      }
      // Check if same_slot_buyers column exists on this day file
      try {
        db.prepare("SELECT same_slot_buyers FROM migrations LIMIT 0").get();
        query += ", same_slot_buyers";
      } catch {
        // column doesn't exist on this day file
      }
      query += " FROM migrations ORDER BY observed_at_ms ASC";

      const rows: any[] = db.prepare(query).all();
      for (const row of rows) {
        if (row.pair_created_at_ms == null) continue;
        const existing = clocks.get(row.mint);
        if (
          existing === undefined ||
          row.pair_created_at_ms < existing.clockMs
        ) {
          clocks.set(row.mint, {
            clockMs: row.pair_created_at_ms,
            pairAddress: row.pair_address || null,
            rawJson: row.raw_json,
            nukeRatio: row.nuke_ratio,
            top5Ratio: row.top5_ratio,
            sameSlotBuyers: row.same_slot_buyers,
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
  liq_quote: number;
  tx_5m_buys: number;
  tx_5m_sells: number;
}

function findClosestPumpswapPair(mint: string, clockMs: number): string | null {
  if (!existsSync(TAPE_DIR)) {
    return null;
  }

  const files = readdirSync(TAPE_DIR);
  let bestPairAddress = null;
  let bestDiff = Infinity;
  const TEN_MINUTES_MS = 10 * 60 * 1000;

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

    const ticks: any[] = db.prepare(`
      SELECT pair_address, pair_created_at_ms FROM market_ticks
      WHERE mint = ? AND dex_id = 'pumpswap'
      AND pair_created_at_ms IS NOT NULL
      ORDER BY pair_created_at_ms ASC
    `).all(mint);

    for (const tick of ticks) {
      const diff = Math.abs(tick.pair_created_at_ms - clockMs);
      if (diff < TEN_MINUTES_MS && diff < bestDiff) {
        bestDiff = diff;
        bestPairAddress = tick.pair_address;
      }
    }

    db.close();
  }

  return bestPairAddress;
}

function getSixHourTicks(mint: string, clockMs: number, pairAddress: string) {
  if (!existsSync(TAPE_DIR)) {
    return { entry: null as Tick | null, ticks: [] as Tick[], peak: 0, peakMs: 0 };
  }

  const files = readdirSync(TAPE_DIR);
  let entryTick: Tick | null = null;
  let entryObserved = Infinity;

  // First pass: find earliest entry tick across all day files
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
        "SELECT mint, price_usd, observed_at_ms, liq_usd, liq_quote, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND pair_address=? AND observed_at_ms >= ? ORDER BY observed_at_ms ASC LIMIT 1"
      )
      .all(mint, pairAddress, entryAfterMs);

    if (potentialEntries.length > 0) {
      const candidate = potentialEntries[0];
      if (candidate.price_usd > 0 && candidate.observed_at_ms < entryObserved) {
        entryObserved = candidate.observed_at_ms;
        entryTick = candidate;
      }
    }

    db.close();
  }

  if (entryTick === null) {
    return { entry: null, ticks: [], peak: 0, peakMs: 0 };
  }

  // Second pass: query all day files for ticks from entry to entry + 6 hours
  const sixHourEnd = entryTick.observed_at_ms + 6 * 60 * 60 * 1000;
  let allTicks: Tick[] = [entryTick]; // include entry tick itself

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

    const ticks: Tick[] = db
      .prepare(
        "SELECT mint, price_usd, observed_at_ms, liq_usd, liq_quote, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND pair_address=? AND observed_at_ms >= ? AND observed_at_ms <= ? ORDER BY observed_at_ms ASC"
      )
      .all(mint, pairAddress, entryTick.observed_at_ms, sixHourEnd);

    allTicks = allTicks.concat(ticks);
    db.close();
  }

  allTicks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);

  // Find peak
  let peak = entryTick.price_usd;
  let peakMs = entryTick.observed_at_ms;
  for (const t of allTicks) {
    if (t.price_usd > peak) {
      peak = t.price_usd;
      peakMs = t.observed_at_ms;
    }
  }

  return { entry: entryTick, ticks: allTicks, peak, peakMs };
}

function getTicksForMint(mint: string, clockMs: number, pairAddress: string) {
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
        "SELECT mint, price_usd, observed_at_ms, liq_usd, liq_quote, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND pair_address=? AND observed_at_ms >= ? ORDER BY observed_at_ms ASC LIMIT 1"
      )
      .all(mint, pairAddress, entryAfterMs);

    if (potentialEntries.length > 0) {
      const candidate = potentialEntries[0];
      if (candidate.price_usd > 0 && candidate.observed_at_ms < entryObserved) {
        entryObserved = candidate.observed_at_ms;
        entryTick = candidate;
      }
    }

    const ticks: Tick[] = db
      .prepare(
        "SELECT mint, price_usd, observed_at_ms, liq_usd, liq_quote, tx_5m_buys, tx_5m_sells FROM market_ticks WHERE mint=? AND pair_address=? AND observed_at_ms > ? ORDER BY observed_at_ms ASC"
      )
      .all(mint, pairAddress, entryAfterMs);

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
  if (field === "nuke_ratio") {
    if (value < 0.3) return "<0.3";
    if (value < 1.0) return "0.3-1";
    return ">=1";
  }
  if (field === "top5_ratio") {
    if (value < 1) return "<1";
    if (value < 3) return "1-3";
    return ">=3";
  }
  if (field === "same_slot_buyers") {
    if (value === 0) return "0";
    if (value === 1) return "1";
    if (value < 6) return "2-5";
    return ">=6";
  }
  return "unknown";
}

// Capture scoring for runner names (peak >= 20x entry)
// Capture = exit price / 6h peak

function scoreCaptureFlat(ticks: Tick[], entryPrice: number, level: number, peak: number) {
  for (const tick of ticks) {
    if (tick.price_usd >= entryPrice * (1 + level)) {
      return tick.price_usd / peak;
    }
  }
  // Never fired: exit at last tick
  return ticks[ticks.length - 1].price_usd / peak;
}

function scoreCaptureTrail(ticks: Tick[], entryPrice: number, armLevel: number, trail: number, peak: number) {
  let armed = false;
  let trailPeak = entryPrice;
  for (const tick of ticks) {
    if (!armed) {
      if (tick.price_usd >= entryPrice * (1 + armLevel)) {
        armed = true;
        trailPeak = tick.price_usd;
      }
    } else {
      if (tick.price_usd > trailPeak) {
        trailPeak = tick.price_usd;
      }
      if (tick.price_usd <= trailPeak * (1 - trail)) {
        return tick.price_usd / peak;
      }
    }
  }
  // Never fired: exit at last tick
  return ticks[ticks.length - 1].price_usd / peak;
}

function scoreCaptureTimed(ticks: Tick[], entryTick: Tick, minutes: number, peak: number) {
  const clockMs = entryTick.observed_at_ms + minutes * 60 * 1000;
  let lastBefore = ticks[0];
  for (const tick of ticks) {
    if (tick.observed_at_ms >= clockMs) {
      break;
    }
    lastBefore = tick;
  }
  return lastBefore.price_usd / peak;
}

function scoreCaptureTimedAfterArm(ticks: Tick[], entryPrice: number, armLevel: number, minutes: number) {
  const armMs = ticks.reduce((best: number, t: Tick) => {
    if (best === 0 && t.price_usd >= entryPrice * (1 + armLevel)) {
      return t.observed_at_ms;
    }
    return best;
  }, 0);
  
  if (armMs === 0) return null; // never armed
  
  const clockMs = armMs + minutes * 60 * 1000;
  let lastBefore = ticks[0];
  for (const tick of ticks) {
    if (tick.observed_at_ms >= clockMs) {
      break;
    }
    lastBefore = tick;
  }
  return lastBefore;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function main() {
  console.log("[migration-grid] collecting migration clocks...");
  const clocks = collectMigrationClocks();
  console.log(`[migration-grid] ${clocks.size} mints with migration clocks`);

  if (clocks.size === 0) {
    console.log("[migration-grid] no migration data found");
    return;
  }

  // Resolve pair addresses for migrations that don't have one
  let resolved = 0;
  let fromRow = 0;
  let fromTick = 0;
  let none = 0;

  for (const [mint, info] of clocks.entries()) {
    resolved++;
    if (info.pairAddress !== null) {
      fromRow++;
      continue;
    }

    const bestPair = findClosestPumpswapPair(mint, info.clockMs);
    if (bestPair) {
      info.pairAddress = bestPair;
      fromTick++;
    } else {
      none++;
    }
  }

  console.log(`pairs resolved=${resolved} fromRow=${fromRow} fromTick=${fromTick} none=${none}`);

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
    entryLiq: number | null;
    entryBuySell: number | null;
    runner: number;
    results: Record<string, PolicyResult>;
    sixHour?: any;
    nukeRatio: number | null;
  }[] = [];

  // Runner peak data collected during main loop
  interface RunnerInfo {
    entryPrice: number;
    peak: number;
    peakMs: number;
    entryMs: number;
    ticks: Tick[];
    runner: number;
  }
  const runners: RunnerInfo[] = [];

  let i = 0;
  for (const [mint, clockInfo] of clocks.entries()) {
    i++;
    if (i % 50 === 0) {
      console.log(`[migration-grid] ${i}/${clocks.size}...`);
    }

    const { entry, ticks } = getTicksForMint(mint, clockInfo.clockMs, clockInfo.pairAddress);

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

    const entryBuySell = entry.tx_5m_sells > 0 ? entry.tx_5m_buys / entry.tx_5m_sells : null;
    // Compute 6h runner for this mint
    const six = getSixHourTicks(mint, clockInfo.clockMs, clockInfo.pairAddress);
    let runner = 0;
    if (six.entry !== null && six.peak > 0) {
      runner = six.peak / six.entry.price_usd - 1;
      if (runner >= 20) {
        runners.push({
          entryPrice: six.entry.price_usd,
          peak: six.peak,
          peakMs: six.peakMs,
          entryMs: six.entry.observed_at_ms,
          ticks: six.ticks,
          runner,
        });
      }
    }
    mintData.push({ mint, rawJson: clockInfo.rawJson, entryLiq: entry.liq_usd, entryBuySell, runner, results, nukeRatio: clockInfo.nukeRatio });
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

  // Runner counts
  let r2 = 0, r10 = 0, r20 = 0;
  for (const md of mintData) {
    if (md.runner >= 2) r2++;
    if (md.runner >= 10) r10++;
    if (md.runner >= 20) r20++;
  }
  console.log(`runners 6h: +200%=${r2} +1000%=${r10} +2000%=${r20} of n=${mintData.length}`);

  // Runner peak analysis: split wick from path
  console.log("\n=== Runner Peak Grid (peak >= 20x) ===");
  
  // Split into wick (peak within 60s of entry) vs path (peak after 60s)
  const wicks: RunnerInfo[] = [];
  const paths: RunnerInfo[] = [];
  for (const r of runners) {
    const peakLag = r.peakMs - r.entryMs;
    if (peakLag <= 60 * 1000) {
      wicks.push(r);
    } else {
      paths.push(r);
    }
  }
  
  console.log(`runners 6h: wick=${wicks.length} path=${paths.length} of n=${runners.length}`);
  
  // Path time-to-peak stats
  if (paths.length > 0) {
    const times: number[] = [];
    for (const r of paths) {
      const mins = (r.peakMs - r.entryMs) / (60 * 1000);
      times.push(mins);
    }
    console.log(`path time-to-peak min=${percentile(times, 0).toFixed(1)} p25=${percentile(times, 25).toFixed(1)} median=${percentile(times, 50).toFixed(1)} p75=${percentile(times, 75).toFixed(1)} max=${percentile(times, 100).toFixed(1)}`);
  } else {
    console.log("path time-to-peak n=0");
  }
  
  if (paths.length === 0) {
    // No path names, stop here
  } else {
    // Capture rules on path names only
    console.log("\n--- Capture rules on path names (exit / peak) ---");
    
    // Flat sells
    const flatLevels = [1.0, 2.0, 5.0, 10.0];
    for (const level of flatLevels) {
      const captures: number[] = [];
      for (const r of paths) {
        captures.push(scoreCaptureFlat(r.ticks, r.entryPrice, level, r.peak));
      }
      const med = percentile(captures, 50);
      const halfPeak = captures.filter(c => c >= 0.5).length / captures.length * 100;
      console.log(`flat${Math.round(level * 100)}: n=${paths.length} medianCapture=${(med * 100).toFixed(1)}% halfPeak=${halfPeak.toFixed(1)}%`);
    }
    
    // Trail rules
    const trailRules = [
      { name: "arm100-trail20", arm: 1.0, trail: 0.2 },
      { name: "arm100-trail40", arm: 1.0, trail: 0.4 },
      { name: "arm200-trail20", arm: 2.0, trail: 0.2 },
      { name: "arm200-trail30", arm: 2.0, trail: 0.3 },
      { name: "arm200-trail40", arm: 2.0, trail: 0.4 },
      { name: "arm500-trail20", arm: 5.0, trail: 0.2 },
      { name: "arm500-trail40", arm: 5.0, trail: 0.4 },
    ];
    for (const rule of trailRules) {
      const captures: number[] = [];
      for (const r of paths) {
        captures.push(scoreCaptureTrail(r.ticks, r.entryPrice, rule.arm, rule.trail, r.peak));
      }
      const med = percentile(captures, 50);
      const halfPeak = captures.filter(c => c >= 0.5).length / captures.length * 100;
      console.log(`${rule.name}: n=${paths.length} medianCapture=${(med * 100).toFixed(1)}% halfPeak=${halfPeak.toFixed(1)}%`);
    }
    
    // Timed from entry
    const timedLevels = [30, 60, 120, 240];
    for (const mins of timedLevels) {
      const captures: number[] = [];
      for (const r of paths) {
        captures.push(scoreCaptureTimed(r.ticks, { observed_at_ms: r.entryMs } as Tick, mins, r.peak));
      }
      const med = percentile(captures, 50);
      const halfPeak = captures.filter(c => c >= 0.5).length / captures.length * 100;
      console.log(`time${mins}m: n=${paths.length} medianCapture=${(med * 100).toFixed(1)}% halfPeak=${halfPeak.toFixed(1)}%`);
    }
    
    // Timed after arm
    const timedArmRules = [
      { name: "arm100-time30", arm: 1.0, mins: 30 },
      { name: "arm100-time60", arm: 1.0, mins: 60 },
      { name: "arm200-time30", arm: 2.0, mins: 30 },
      { name: "arm200-time60", arm: 2.0, mins: 60 },
    ];
    for (const rule of timedArmRules) {
      const captures: number[] = [];
      let n = 0;
      for (const r of paths) {
        const exitTick = scoreCaptureTimedAfterArm(r.ticks, r.entryPrice, rule.arm, rule.mins);
        if (exitTick !== null) {
          captures.push(exitTick.price_usd / r.peak);
          n++;
        }
      }
      if (n > 0) {
        const med = percentile(captures, 50);
        const halfPeak = captures.filter(c => c >= 0.5).length / captures.length * 100;
        console.log(`${rule.name}: n=${n} medianCapture=${(med * 100).toFixed(1)}% halfPeak=${halfPeak.toFixed(1)}%`);
      } else {
        console.log(`${rule.name}: n=0`);
      }
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
    "nuke_ratio",
    "top5_ratio",
  ];

  // Track best bucket for summary
  let bestFlat30Bucket = null;
  let bestTrailBucket = null;

  for (const policy of POLICIES) {
    console.log(`\n--- ${policy.name} buckets ---`);

    for (const field of bucketFields) {
      const buckets: Record<string, { returns: number[]; hits: number }> = {};

      for (const md of mintData) {
        let value: any;
        if (field === "liq_usd") {
          value = md.entryLiq;
        } else if (field === "buySell") {
          value = md.entryBuySell;
        } else if (field === "nuke_ratio") {
          value = md.nukeRatio;
        } else {
          const parsed = parseMigration(md.rawJson);
          if (!parsed) continue;
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
        if (policy.name === "flat30" && (!bestFlat30Bucket || med > bestFlat30Bucket.median)) {
          bestFlat30Bucket = { name: key, n: data.returns.length, median: med };
        }
        if ((policy.name.startsWith("trail") || policy.name.startsWith("half")) && (!bestTrailBucket || med > bestTrailBucket.median)) {
          bestTrailBucket = { name: key, n: data.returns.length, median: med };
        }
      }
    }
  }

  // Cross section: pairs of strong buckets on flat30 only
  console.log("\n=== Cross buckets (flat30 only) ===");
  const flags = [
    { name: "holders500", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.holder_count >= 500;
    } },
    { name: "grad5to30", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.complete_cost_time >= 300 && parsed.complete_cost_time < 1800;
    } },
    { name: "top10low", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.top_10_holder_rate < 0.2;
    } },
    { name: "creatorOut", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.creator_token_status === "creator_close";
    } },
    { name: "bundlerMid", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.bundler_trader_amount_rate >= 0.1 && parsed.bundler_trader_amount_rate < 0.3;
    } },
    { name: "smart1", test: (md: typeof mintData[0]) => {
      const parsed = parseMigration(md.rawJson);
      return parsed && parsed.smart_degen_count >= 1;
    } },
  ];

  let bestCross = null;
  for (let i = 0; i < flags.length; i++) {
    for (let j = i + 1; j < flags.length; j++) {
      const returns: number[] = [];
      let hits = 0;
      let pair2 = 0, pair10 = 0, pair20 = 0;
      for (const md of mintData) {
        if (flags[i].test(md) && flags[j].test(md)) {
          returns.push(md.results["flat30"].return);
          if (md.results["flat30"].hit) {
            hits++;
          }
          if (md.runner >= 2) pair2++;
          if (md.runner >= 10) pair10++;
          if (md.runner >= 20) pair20++;
        }
      }
      if (returns.length < 30) continue;
      const med = median(returns);
      const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
      const hitRate = (hits / returns.length) * 100;
      console.log(`${flags[i].name} x ${flags[j].name}: n=${returns.length} hit=${hitRate.toFixed(1)}% median=${(med * 100).toFixed(1)}% runners 6h: +200%=${pair2} +1000%=${pair10} +2000%=${pair20}`);
      if (!bestCross || med > bestCross.median) {
        bestCross = { name: `${flags[i].name} x ${flags[j].name}`, n: returns.length, median: med };
      }
    }
  }
  if (bestCross) {
    console.log(`best cross: ${bestCross.name} n=${bestCross.n} median=${(bestCross.median * 100).toFixed(1)}%`);
  } else {
    console.log("best cross: none");
  }

  // Best flat30 bucket summary
  console.log("\n=== Best flat30 bucket ===");
  if (bestFlat30Bucket) {
    console.log(`best flat30 bucket: ${bestFlat30Bucket.name} n=${bestFlat30Bucket.n} median=${(bestFlat30Bucket.median * 100).toFixed(1)}%`);
  } else {
    console.log("best flat30 bucket: none found with n>=30");
  }

  // Best trail bucket summary
  console.log("\n=== Best trail bucket ===");
  if (bestTrailBucket) {
    console.log(`best trail: ${bestTrailBucket.name} n=${bestTrailBucket.n} median=${(bestTrailBucket.median * 100).toFixed(1)}%`);
  } else {
    console.log("best trail: none found with n>=30");
  }

  // Rug vs TP: which entry fields belong to names that hit +30% before -50%?
  console.log("\n=== Rug vs TP ===");

  const rugTpData: {
    mint: string;
    rawJson: string | null;
    entryLiq: number | null;
    entryBuySell: number | null;
    outcome: "tp_first" | "rug_first" | "neither";
    timeToRug: number | null;
    poolDrop: number | null;
  }[] = [];

  for (const md of mintData) {
    const clockInfo = clocks.get(md.mint);
    if (!clockInfo) continue;
    const six = getSixHourTicks(md.mint, clockInfo.clockMs, clockInfo.pairAddress);
    if (six.entry === null || six.ticks.length === 0) continue;

    const entryPrice = six.entry.price_usd;
    let tp: Tick | null = null;
    let rug: Tick | null = null;

    for (const t of six.ticks) {
      if (tp === null && t.price_usd >= entryPrice * 1.3) {
        tp = t;
      }
      if (rug === null && t.price_usd <= entryPrice * 0.5) {
        rug = t;
      }
      if (tp !== null && rug !== null) break;
    }

    let outcome: "tp_first" | "rug_first" | "neither";
    let timeToRug: number | null = null;
    if (tp !== null && (rug === null || tp.observed_at_ms <= rug.observed_at_ms)) {
      outcome = "tp_first";
    } else if (rug !== null) {
      outcome = "rug_first";
      timeToRug = (rug.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
    } else {
      outcome = "neither";
    }

    // Pool drop at 60s
    const entryLiqQuote = six.entry.liq_quote;
    let poolDrop: number | null = null;
    if (entryLiqQuote > 0) {
      const sixtySecMs = six.entry.observed_at_ms + 60 * 1000;
      let tick60: Tick | null = null;
      for (const t of six.ticks) {
        if (t.observed_at_ms >= sixtySecMs) {
          tick60 = t;
          break;
        }
      }
      if (tick60 !== null && tick60.liq_quote > 0) {
        poolDrop = 1 - (tick60.liq_quote / entryLiqQuote);
      }
    }

    rugTpData.push({
      mint: md.mint,
      rawJson: md.rawJson,
      entryLiq: md.entryLiq,
      entryBuySell: md.entryBuySell,
      outcome,
      timeToRug,
      poolDrop,
    });
  }

  let tpFirstCount = 0;
  let rugFirstCount = 0;
  let neitherCount = 0;
  for (const rt of rugTpData) {
    if (rt.outcome === "tp_first") tpFirstCount++;
    else if (rt.outcome === "rug_first") rugFirstCount++;
    else neitherCount++;
  }
  const rugN = rugTpData.length;
  console.log(
    `n=${rugN} tp_first=${tpFirstCount} (${((tpFirstCount / rugN) * 100).toFixed(1)}%) rug_first=${rugFirstCount} (${((rugFirstCount / rugN) * 100).toFixed(1)}%) neither=${neitherCount} (${((neitherCount / rugN) * 100).toFixed(1)}%)`
  );

  const rugTpFields = [
    "liq_usd",
    "top_10_holder_rate",
    "creator_token_status",
    "holder_count",
    "bundler_trader_amount_rate",
    "smart_degen_count",
    "sniper_count",
    "buySell",
    "complete_cost_time",
    "nuke_ratio",
    "top5_ratio",
    "same_slot_buyers",
  ];

  for (const field of rugTpFields) {
    const buckets: Record<string, { n: number; tpFirst: number; rugFirst: number }> = {};

    for (const rt of rugTpData) {
      let value: any;
      if (field === "liq_usd") {
        value = rt.entryLiq;
      } else if (field === "buySell") {
        value = rt.entryBuySell;
      } else if (field === "nuke_ratio") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        value = clockInfo.nukeRatio;
      } else if (field === "top5_ratio") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        value = clockInfo.top5Ratio;
      } else if (field === "same_slot_buyers") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        if (clockInfo.sameSlotBuyers <= 0) continue;
        value = clockInfo.sameSlotBuyers;
      } else {
        const parsed = parseMigration(rt.rawJson);
        if (!parsed) continue;
        value = parsed[field];
      }

      if (value === undefined || value === null) continue;

      const label = bucketLabel(field, value);
      const key = `${field}:${label}`;
      if (!buckets[key]) {
        buckets[key] = { n: 0, tpFirst: 0, rugFirst: 0 };
      }
      buckets[key].n++;
      if (rt.outcome === "tp_first") buckets[key].tpFirst++;
      else if (rt.outcome === "rug_first") buckets[key].rugFirst++;
    }

    for (const [key, data] of Object.entries(buckets)) {
      if (data.n < 30) continue;
      const tpRate = (data.tpFirst / data.n) * 100;
      const rugRate = (data.rugFirst / data.n) * 100;
      console.log(`${key} n=${data.n} tp=${tpRate.toFixed(1)}% rug=${rugRate.toFixed(1)}%`);
    }
  }

  // Pool drop at 60s
  console.log("\n=== Pool drop at 60s ===");
  interface PoolDropBucket {
    n: number;
    fastRug: number;
    tpFirst: number;
  }
  const poolDropBuckets: Record<string, PoolDropBucket> = {
    "drop <0.2": { n: 0, fastRug: 0, tpFirst: 0 },
    "drop 0.2-0.5": { n: 0, fastRug: 0, tpFirst: 0 },
    "drop >=0.5": { n: 0, fastRug: 0, tpFirst: 0 },
  };

  for (const md of mintData) {
    const clockInfo = clocks.get(md.mint);
    if (!clockInfo) continue;
    const six = getSixHourTicks(md.mint, clockInfo.clockMs, clockInfo.pairAddress);
    if (six.entry === null || six.ticks.length === 0) continue;

    const entryPrice = six.entry.price_usd;
    const entryLiqQuote = six.entry.liq_quote;
    if (entryLiqQuote <= 0) continue;

    // Find first tick at or after 60s
    const sixtySec = six.entry.observed_at_ms + 60 * 1000;
    let tick60: Tick | null = null;
    for (const t of six.ticks) {
      if (t.observed_at_ms >= sixtySec) {
        tick60 = t;
        break;
      }
    }
    if (tick60 === null || tick60.liq_quote <= 0) continue;

    const poolDrop = 1 - (tick60.liq_quote / entryLiqQuote);

    let bucketKey: string;
    if (poolDrop < 0.2) bucketKey = "drop <0.2";
    else if (poolDrop < 0.5) bucketKey = "drop 0.2-0.5";
    else bucketKey = "drop >=0.5";

    poolDropBuckets[bucketKey].n++;

    // Determine fast-rug and take-profit outcomes
    let tp: Tick | null = null;
    let rug: Tick | null = null;
    for (const t of six.ticks) {
      if (tp === null && t.price_usd >= entryPrice * 1.3) {
        tp = t;
      }
      if (rug === null && t.price_usd <= entryPrice * 0.5) {
        rug = t;
      }
      if (tp !== null && rug !== null) break;
    }

    const isTpFirst = tp !== null && (rug === null || tp.observed_at_ms <= rug.observed_at_ms);
    if (isTpFirst) {
      poolDropBuckets[bucketKey].tpFirst++;
    } else {
      const timeToRug = (rug === null) ? null : (rug.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
      if (timeToRug !== null && timeToRug <= 3) {
        poolDropBuckets[bucketKey].fastRug++;
      }
    }
  }

  for (const key of ["drop <0.2", "drop 0.2-0.5", "drop >=0.5"]) {
    const b = poolDropBuckets[key];
    if (b.n === 0) {
      console.log(`${key}: n=0 fast=0.0% tp=0.0%`);
    } else {
      const fastPct = (b.fastRug / b.n) * 100;
      const tpPct = (b.tpFirst / b.n) * 100;
      console.log(`${key}: n=${b.n} fast=${fastPct.toFixed(1)}% tp=${tpPct.toFixed(1)}%`);
    }
  }

  // Time to rug for names that got raged: first tick at or below 50% entry price
  console.log("\n=== Time to rug ===");
  const allRugTimes: number[] = [];
  const gradRugTimes: number[] = [];
  const fatSmartRugTimes: number[] = [];

  for (const rt of rugTpData) {
    if (rt.outcome !== "rug_first") continue;
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo) continue;
    const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
    if (six.entry === null) continue;
    const entryPrice = six.entry.price_usd;
    let timeToRug: number | null = null;
    for (const t of six.ticks) {
      if (t.price_usd <= entryPrice * 0.5) {
        timeToRug = (t.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
        break;
      }
    }
    if (timeToRug === null) continue;

    allRugTimes.push(timeToRug);

    const parsed = parseMigration(rt.rawJson);
    if (parsed === null) continue;
    const grad5to30 = parsed.complete_cost_time >= 300 && parsed.complete_cost_time < 1800;

    if (grad5to30) {
      gradRugTimes.push(timeToRug);
    }

    if (
      grad5to30 &&
      rt.entryLiq != null &&
      rt.entryLiq < 25000 &&
      parsed.smart_degen_count >= 1 &&
      parsed.top_10_holder_rate < 0.2 &&
      parsed.creator_token_status === "creator_close"
    ) {
      fatSmartRugTimes.push(timeToRug);
    }
  }

  if (allRugTimes.length > 0) {
    console.log(`rug time-to-hit min=${percentile(allRugTimes, 0).toFixed(1)} p25=${percentile(allRugTimes, 25).toFixed(1)} median=${percentile(allRugTimes, 50).toFixed(1)} p75=${percentile(allRugTimes, 75).toFixed(1)} max=${percentile(allRugTimes, 100).toFixed(1)} n=${allRugTimes.length}`);
  } else {
    console.log("rug time-to-hit n=0");
  }

  if (gradRugTimes.length >= 30) {
    console.log(`grad 5-30m rug time-to-hit min=${percentile(gradRugTimes, 0).toFixed(1)} p25=${percentile(gradRugTimes, 25).toFixed(1)} median=${percentile(gradRugTimes, 50).toFixed(1)} p75=${percentile(gradRugTimes, 75).toFixed(1)} max=${percentile(gradRugTimes, 100).toFixed(1)} n=${gradRugTimes.length}`);
  }

  if (fatSmartRugTimes.length >= 30) {
    console.log(`cross rug time-to-hit min=${percentile(fatSmartRugTimes, 0).toFixed(1)} p25=${percentile(fatSmartRugTimes, 25).toFixed(1)} median=${percentile(fatSmartRugTimes, 50).toFixed(1)} p75=${percentile(fatSmartRugTimes, 75).toFixed(1)} max=${percentile(fatSmartRugTimes, 100).toFixed(1)} n=${fatSmartRugTimes.length}`);
  }

  // Fast rug: hit -50% inside 3 minutes of entry
  console.log("\n=== Fast rug (hit -50% inside 3m) ===");

  let totalFast = 0;
  let totalSlow = 0;
  let totalNotRug = 0;
  for (const rt of rugTpData) {
    if (rt.outcome === "tp_first" || rt.timeToRug == null) {
      totalNotRug++;
    } else if (rt.timeToRug <= 3) {
      totalFast++;
    } else {
      totalSlow++;
    }
  }
  const fastN = rugTpData.length;
  console.log(
    `n=${fastN} fast=${totalFast} (${((totalFast / fastN) * 100).toFixed(1)}%) slow=${totalSlow} (${((totalSlow / fastN) * 100).toFixed(1)}%) not_rug=${totalNotRug}`
  );

  const fastRugFields = [
    "liq_usd",
    "top_10_holder_rate",
    "creator_token_status",
    "holder_count",
    "bundler_trader_amount_rate",
    "smart_degen_count",
    "sniper_count",
    "buySell",
    "complete_cost_time",
    "nuke_ratio",
    "top5_ratio",
    "same_slot_buyers",
  ];

  for (const field of fastRugFields) {
    const buckets: Record<string, { n: number; fast: number; slow: number; notRug: number }> = {};

    for (const rt of rugTpData) {
      let value: any;
      if (field === "liq_usd") {
        value = rt.entryLiq;
      } else if (field === "buySell") {
        value = rt.entryBuySell;
      } else if (field === "nuke_ratio") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        value = clockInfo.nukeRatio;
      } else if (field === "top5_ratio") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        value = clockInfo.top5Ratio;
      } else if (field === "same_slot_buyers") {
        const clockInfo = clocks.get(rt.mint);
        if (!clockInfo) continue;
        if (clockInfo.sameSlotBuyers <= 0) continue;
        value = clockInfo.sameSlotBuyers;
      } else {
        const parsed = parseMigration(rt.rawJson);
        if (!parsed) continue;
        value = parsed[field];
      }

      if (value === undefined || value === null) continue;

      const label = bucketLabel(field, value);
      const key = `${field}:${label}`;
      if (!buckets[key]) {
        buckets[key] = { n: 0, fast: 0, slow: 0, notRug: 0 };
      }
      buckets[key].n++;

      if (rt.outcome === "tp_first" || rt.timeToRug == null) {
        buckets[key].notRug++;
      } else if (rt.timeToRug <= 3) {
        buckets[key].fast++;
      } else {
        buckets[key].slow++;
      }
    }

    for (const [key, data] of Object.entries(buckets)) {
      const fastPct = data.n > 0 ? (data.fast / data.n) * 100 : 0;
      const slowPct = data.n > 0 ? (data.slow / data.n) * 100 : 0;
      console.log(`${key} n=${data.n} fast=${data.fast} (${fastPct.toFixed(1)}%) slow=${data.slow} (${slowPct.toFixed(1)}%)`);
    }
  }

  // Nuke vs time to rug: for each nuke bucket, rug-first rate and how fast the rug hit
  console.log("\n=== Nuke vs time to rug ===");

  interface NukeBucket {
    n: number;
    tpFirst: number;
    rugFirst: number;
    rug5m: number;
    rug30m: number;
  }

  const nukeBuckets: Record<string, NukeBucket> = {
    "nuke <0.3": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "nuke 0.3-1": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "nuke >=1": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
  };

  for (const rt of rugTpData) {
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo || clockInfo.nukeRatio == null) continue;

    const nuke = clockInfo.nukeRatio;
    let bucketKey: string;
    if (nuke < 0.3) bucketKey = "nuke <0.3";
    else if (nuke < 1.0) bucketKey = "nuke 0.3-1";
    else bucketKey = "nuke >=1";

    const b = nukeBuckets[bucketKey];
    b.n++;

    if (rt.outcome === "tp_first") {
      b.tpFirst++;
    } else if (rt.outcome === "rug_first") {
      b.rugFirst++;
      const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
      if (six.entry === null) continue;
      const entryPrice = six.entry.price_usd;
      let timeToRug: number | null = null;
      for (const t of six.ticks) {
        if (t.price_usd <= entryPrice * 0.5) {
          timeToRug = (t.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
          break;
        }
      }
      if (timeToRug != null && timeToRug < 5) b.rug5m++;
      if (timeToRug != null && timeToRug < 30) b.rug30m++;
    }
  }

  for (const key of ["nuke <0.3", "nuke 0.3-1", "nuke >=1"]) {
    const b = nukeBuckets[key];
    const tpPct = b.n > 0 ? (b.tpFirst / b.n) * 100 : 0;
    const rugPct = b.n > 0 ? (b.rugFirst / b.n) * 100 : 0;
    console.log(`${key}: n=${b.n} tp=${tpPct.toFixed(1)}% rug=${rugPct.toFixed(1)}% rug<5m=${b.rug5m} rug<30m=${b.rug30m}`);
  }

  // Top5 vs time to rug
  console.log("\n=== Top5 vs time to rug ===");

  const top5Buckets: Record<string, NukeBucket> = {
    "top5 <1": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "top5 1-3": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "top5 >=3": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
  };

  for (const rt of rugTpData) {
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo || clockInfo.top5Ratio == null) continue;

    const top5 = clockInfo.top5Ratio;
    let bucketKey: string;
    if (top5 < 1) bucketKey = "top5 <1";
    else if (top5 < 3) bucketKey = "top5 1-3";
    else bucketKey = "top5 >=3";

    const b = top5Buckets[bucketKey];
    b.n++;

    if (rt.outcome === "tp_first") {
      b.tpFirst++;
    } else if (rt.outcome === "rug_first") {
      b.rugFirst++;
      const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
      if (six.entry === null) continue;
      const entryPrice = six.entry.price_usd;
      let timeToRug: number | null = null;
      for (const t of six.ticks) {
        if (t.price_usd <= entryPrice * 0.5) {
          timeToRug = (t.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
          break;
        }
      }
      if (timeToRug != null && timeToRug < 5) b.rug5m++;
      if (timeToRug != null && timeToRug < 30) b.rug30m++;
    }
  }

  for (const key of ["top5 <1", "top5 1-3", "top5 >=3"]) {
    const b = top5Buckets[key];
    const tpPct = b.n > 0 ? (b.tpFirst / b.n) * 100 : 0;
    const rugPct = b.n > 0 ? (b.rugFirst / b.n) * 100 : 0;
    console.log(`${key}: n=${b.n} tp=${tpPct.toFixed(1)}% rug=${rugPct.toFixed(1)}% rug<5m=${b.rug5m} rug<30m=${b.rug30m}`);
  }

  // Same-slot vs time to rug
  console.log("\n=== Same-slot vs time to rug ===");

  const sameSlotBuckets: Record<string, NukeBucket> = {
    "same 0": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "same 1": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "same 2-5": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
    "same >=6": { n: 0, tpFirst: 0, rugFirst: 0, rug5m: 0, rug30m: 0 },
  };

  for (const rt of rugTpData) {
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo || clockInfo.sameSlotBuyers == null || clockInfo.sameSlotBuyers <= 0) continue;

    const same = clockInfo.sameSlotBuyers;
    let bucketKey: string;
    if (same === 0) bucketKey = "same 0";
    else if (same === 1) bucketKey = "same 1";
    else if (same < 6) bucketKey = "same 2-5";
    else bucketKey = "same >=6";

    const b = sameSlotBuckets[bucketKey];
    b.n++;

    if (rt.outcome === "tp_first") {
      b.tpFirst++;
    } else if (rt.outcome === "rug_first") {
      b.rugFirst++;
      const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
      if (six.entry === null) continue;
      const entryPrice = six.entry.price_usd;
      let timeToRug: number | null = null;
      for (const t of six.ticks) {
        if (t.price_usd <= entryPrice * 0.5) {
          timeToRug = (t.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
          break;
        }
      }
      if (timeToRug != null && timeToRug < 5) b.rug5m++;
      if (timeToRug != null && timeToRug < 30) b.rug30m++;
    }
  }

  for (const key of ["same 0", "same 1", "same 2-5", "same >=6"]) {
    const b = sameSlotBuckets[key];
    const tpPct = b.n > 0 ? (b.tpFirst / b.n) * 100 : 0;
    const rugPct = b.n > 0 ? (b.rugFirst / b.n) * 100 : 0;
    console.log(`${key}: n=${b.n} tp=${tpPct.toFixed(1)}% rug=${rugPct.toFixed(1)}% rug<5m=${b.rug5m} rug<30m=${b.rug30m}`);
  }

  // Sample of high-liquidity rug-first names
  console.log("\n=== Fat book rug sample (>=100k, rug_first) ===");
  let fatCount = 0;
  for (const rt of rugTpData) {
    if (rt.outcome !== "rug_first") continue;
    if (rt.entryLiq == null || rt.entryLiq < 100000) continue;
    if (fatCount >= 8) break;
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo) continue;
    const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
    if (six.entry === null) continue;
    const entryPrice = six.entry.price_usd;
    let minPrice = entryPrice;
    let maxPrice = entryPrice;
    let timeToRug: number | null = null;
    for (const t of six.ticks) {
      if (t.price_usd < minPrice) minPrice = t.price_usd;
      if (t.price_usd > maxPrice) maxPrice = t.price_usd;
      if (timeToRug === null && t.price_usd <= entryPrice * 0.5) {
        timeToRug = (t.observed_at_ms - six.entry.observed_at_ms) / (60 * 1000);
      }
    }
    console.log(`FAT mint=${rt.mint.slice(0, 8)}.. liq=${Math.round(rt.entryLiq).toLocaleString()} entry=${entryPrice.toFixed(6)} min=${minPrice.toFixed(6)} max=${maxPrice.toFixed(6)} rugMin=${timeToRug != null ? timeToRug.toFixed(1) : "-"}`);
    fatCount++;
  }
  console.log(`fat sample shown=${fatCount}`);

  // Sample of low-liquidity tp-first names
  console.log("\n=== Thin book tp sample (<25k, tp_first) ===");
  let thinCount = 0;
  for (const rt of rugTpData) {
    if (rt.outcome !== "tp_first") continue;
    if (rt.entryLiq == null || rt.entryLiq >= 25000) continue;
    if (thinCount >= 8) break;
    const clockInfo = clocks.get(rt.mint);
    if (!clockInfo) continue;
    const six = getSixHourTicks(rt.mint, clockInfo.clockMs, clockInfo.pairAddress);
    if (six.entry === null) continue;
    const entryPrice = six.entry.price_usd;
    let minPrice = entryPrice;
    let maxPrice = entryPrice;
    for (const t of six.ticks) {
      if (t.price_usd < minPrice) minPrice = t.price_usd;
      if (t.price_usd > maxPrice) maxPrice = t.price_usd;
    }
    console.log(`THIN mint=${rt.mint.slice(0, 8)}.. liq=${Math.round(rt.entryLiq).toLocaleString()} entry=${entryPrice.toFixed(6)} min=${minPrice.toFixed(6)} max=${maxPrice.toFixed(6)}`);
    thinCount++;
  }
  console.log(`thin sample shown=${thinCount}`);
}

main();