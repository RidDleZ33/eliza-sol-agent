// Migration path report
// For each mint that appears in the migrations table, backtest three exit policies
// against its price action on the tape.
//
// Clock: the migrations row's pair_created_at_ms (earliest across all day files).
// Entry: first market_ticks row at or after clock + 5 minutes with price_usd > 0.
// Window: 60 minutes from the entry tick's observed_at_ms.
// Policies: sell at +30%, sell at +50%, hold to end.
// Fee: none.
//
// Reads every tape-YYYY-MM-DD.sqlite in data/tape (including outside retain window).
// Ignores tape.sqlite. Opened read-only.

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

interface MigrationRow {
  mint: string;
  pair_address: string;
  pair_created_at_ms: number;
}

function collectMigrationClocks(): Map<string, number> {
  const clocks = new Map<string, number>();

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
      console.log(`[migrations] cannot open ${f}: ${e.message}`);
      continue;
    }

    try {
      const rows: MigrationRow[] = db
        .prepare(
          "SELECT mint, pair_address, pair_created_at_ms FROM migrations ORDER BY observed_at_ms ASC"
        )
        .all();
      for (const row of rows) {
        if (row.pair_created_at_ms == null) continue;
        const existing = clocks.get(row.mint);
        if (existing === undefined || row.pair_created_at_ms < existing) {
          clocks.set(row.mint, row.pair_created_at_ms);
        }
      }
    } catch (e: any) {
      console.log(`[migrations] query failed on ${f}: ${e.message}`);
    }

    db.close();
  }

  return clocks;
}

function getTicksForMint(
  mint: string,
  clockMs: number
): {
  entry: any;
  ticks: any[];
} {
  if (!existsSync(TAPE_DIR)) return { entry: null, ticks: [] };

  const files = readdirSync(TAPE_DIR);
  let entryTick: any = null;
  let entryObserved = Infinity;
  let allTicks: any[] = [];

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

    const potentialEntries = db
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

    const ticks = db
      .prepare(
        "SELECT mint, price_usd, observed_at_ms FROM market_ticks WHERE mint=? AND observed_at_ms > ? ORDER BY observed_at_ms ASC"
      )
      .all(mint, entryAfterMs);

    allTicks = allTicks.concat(ticks);

    db.close();
  }

  allTicks.sort((a, b) => a.observed_at_ms - b.observed_at_ms);

  let windowTicks: any[] = [];
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

function runBacktest(mint: string, clockMs: number) {
  const { entry, ticks } = getTicksForMint(mint, clockMs);

  if (entry === null || ticks.length === 0) {
    return {
      scored: false,
      entryPrice: 0,
      entryLiq: 0,
      buySellRatio: 0,
      ticksAfterEntry: 0,
      policies: { p30: null, p50: null, pHold: null } as any,
    };
  }

  const entryPrice = entry.price_usd;
  const entryLiq = entry.liq_usd;
  let buySellRatio = 0;
  if (entry.tx_5m_sells > 0) {
    buySellRatio = entry.tx_5m_buys / entry.tx_5m_sells;
  }

  const ticksAfterEntry = ticks.length;

  const p30 = { name: "sell@30%", hits: 0, returns: [] };
  const p50 = { name: "sell@50%", hits: 0, returns: [] };
  const pHold = { name: "hold", returns: [] };

  let p30Exited = false;
  let p50Exited = false;
  let lastPrice = entryPrice;

  for (const tick of ticks) {
    lastPrice = tick.price_usd;
    const ret = tick.price_usd / entryPrice - 1;

    if (!p30Exited && tick.price_usd >= entryPrice * 1.3) {
      p30Exited = true;
      p30.hits = 1;
      p30.returns.push(ret);
    }

    if (!p50Exited && tick.price_usd >= entryPrice * 1.5) {
      p50Exited = true;
      p50.hits = 1;
      p50.returns.push(ret);
    }
  }

  if (!p30Exited) {
    p30.returns.push(lastPrice / entryPrice - 1);
  }
  if (!p50Exited) {
    p50.returns.push(lastPrice / entryPrice - 1);
  }
  pHold.returns.push(lastPrice / entryPrice - 1);

  return {
    scored: true,
    entryPrice,
    entryLiq,
    buySellRatio: buySellRatio > 0 ? buySellRatio : null,
    ticksAfterEntry,
    policies: { p30, p50, pHold },
  };
}

function main() {
  console.log("[migrations] collecting migration clocks...");
  const clocks = collectMigrationClocks();
  console.log(`[migrations] ${clocks.size} mints with migration clocks`);

  if (clocks.size === 0) {
    console.log("[migrations] no migration data found");
    return;
  }

  let scored = 0;
  let unscored = 0;
  let totalTicksAfter = 0;
  let mintsWith3plus = 0;
  let buySellRatios: number[] = [];
  let entryLiqs: number[] = [];

  const p30 = { name: "sell@30%", hits: 0, returns: [] };
  const p50 = { name: "sell@50%", hits: 0, returns: [] };
  const pHold = { name: "hold", returns: [] };

  let i = 0;
  for (const [mint, clockMs] of clocks.entries()) {
    i++;
    if (i % 50 === 0) {
      console.log(`[migrations] ${i}/${clocks.size}...`);
    }

    const result = runBacktest(mint, clockMs);

    if (!result.scored) {
      unscored++;
      continue;
    }

    scored++;
    totalTicksAfter += result.ticksAfterEntry;
    if (result.ticksAfterEntry >= 3) {
      mintsWith3plus++;
    }
    if (result.entryLiq > 0) {
      entryLiqs.push(result.entryLiq);
    }
    if (result.buySellRatio !== null) {
      buySellRatios.push(result.buySellRatio);
    }

    const r30 = result.policies.p30;
    p30.hits += r30.hits;
    p30.returns.push(...r30.returns);

    const r50 = result.policies.p50;
    p50.hits += r50.hits;
    p50.returns.push(...r50.returns);

    const rHold = result.policies.pHold;
    pHold.returns.push(...rHold.returns);
  }

  console.log("\n=== Migration Path Report ===");
  console.log(`Mints in migrations table: ${clocks.size}`);
  console.log(`Scored: ${scored}`);
  console.log(`Unscored: ${unscored}`);

  if (scored > 0) {
    console.log("\nEntry conditions (scored only):");
    console.log(`  Median liquidity at entry: $${Math.round(median(entryLiqs)).toLocaleString()}`);
    console.log(
      `  Median buy/sell ratio at entry: ${
        buySellRatios.length > 0 ? median(buySellRatios).toFixed(2) : "N/A"
      }`
    );
    console.log(`  Mints with >= 3 ticks after entry: ${mintsWith3plus}`);

    console.log("\nPolicy results:");
    for (const p of [p30, p50]) {
      const hitRate = scored > 0 ? ((p.hits / scored) * 100).toFixed(1) : "0.0";
      const avgRet =
        p.returns.length > 0
          ? (p.returns.reduce((a, b) => a + b, 0) / p.returns.length) * 100
          : 0;
      console.log(
        `  ${p.name}: hits=${p.hits}/${scored} (${hitRate}%), avg return=${avgRet.toFixed(
          1
        )}%, median return=${(median(p.returns) * 100).toFixed(1)}%, sum return=${(
          p.returns.reduce((a, b) => a + b, 0) * 100
        ).toFixed(1)}%`
      );
    }
    const holdAvgRet =
      pHold.returns.length > 0
        ? (pHold.returns.reduce((a, b) => a + b, 0) / pHold.returns.length) * 100
        : 0;
    console.log(
      `  ${pHold.name}: avg return=${holdAvgRet.toFixed(1)}%, median return=${(
        median(pHold.returns) * 100
      ).toFixed(1)}%, sum return=${(
        pHold.returns.reduce((a, b) => a + b, 0) * 100
      ).toFixed(1)}%`
    );
  }
}

main();
