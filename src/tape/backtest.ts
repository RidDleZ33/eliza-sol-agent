// Recipe-driven backtest.
// Scores a single compiled recipe against the tape grid: for each mint,
// apply entry delay, gates, then exit rules. Returns aggregate stats.

import { getTicksForMint } from "./migrationGrid.ts";
import type { CompiledRecipe } from "../recipes/compile.ts";


import { existsSync, readdirSync } from "fs";
import Database from "better-sqlite3";

const TAPE_DIR = "data/tape";

interface MigrationClockInfo {
  clockMs: number;
  pairAddress: string | null;
  rawJson: string | null;
}

function openReadOnly(path: string) {
  return new Database(path, { readonly: true });
}

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

function collectRecentClocks(cutoffMs: number): Map<string, MigrationClockInfo> {
  const clocks = new Map<string, MigrationClockInfo>();
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  if (!existsSync(TAPE_DIR)) {
    return clocks;
  }

  const files = readdirSync(TAPE_DIR);

  for (const f of files) {
    if (f === "tape.sqlite") continue;
    const datePart = dateFromFilename(f);
    if (!datePart) continue;
    if (datePart < cutoffDate) continue;

    const path = `${TAPE_DIR}/${f}`;
    let db: Database;
    try {
      db = openReadOnly(path);
    } catch {
      continue;
    }

    try {
      const rows: any[] = db.prepare(
        "SELECT mint, pair_address, pair_created_at_ms, raw_json FROM migrations WHERE pair_created_at_ms >= ? AND pair_created_at_ms IS NOT NULL ORDER BY pair_created_at_ms ASC"
      ).all(cutoffMs);

      for (const row of rows) {
        const existing = clocks.get(row.mint);
        if (existing === undefined || row.pair_created_at_ms < existing.clockMs) {
          clocks.set(row.mint, {
            clockMs: row.pair_created_at_ms,
            pairAddress: row.pair_address || null,
            rawJson: row.raw_json,
          });
        }
      }
    } catch {
      // query failed on this file
    }

    db.close();
  }

  return clocks;
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

function applyGates(recipe: CompiledRecipe, rawJson: string | null): boolean {
  let parsed: any = null;
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      // unparsable
    }
  }
  const { filter } = recipe;

  if (filter.liq_min_usd !== undefined) {
    const liq = parsed?.liq_usd ?? 0;
    if (liq < filter.liq_min_usd) return false;
  }

  if (filter.liq_max_usd !== undefined) {
    const liq = parsed?.liq_usd ?? Infinity;
    if (liq > filter.liq_max_usd) return false;
  }

  if (filter.holders_min !== undefined) {
    const holders = parsed?.holder_count ?? 0;
    if (holders < filter.holders_min) return false;
  }

  if (filter.top10_required) {
    if (parsed?.top_10_holder_rate === undefined) return false;
  }

  if (filter.creator_required) {
    if (parsed?.creator_token_status === undefined) return false;
  }

  return true;
}

function scoreRecipeExit(recipe: CompiledRecipe, entryPrice: number, ticks: any[]): number {
  const { exits } = recipe;
  let peak = entryPrice;
  let lastHighMs = ticks.length > 0 ? ticks[0].observed_at_ms : 0;
  let trailArmed = false;

  for (const tick of ticks) {
    const price = tick.price_usd;
    const now = tick.observed_at_ms;

    // 1. Pool drop
    if (exits.pool_drop_pct !== undefined) {
      const drop = 1 - tick.liq_quote / ticks[0].liq_quote;
      if (drop >= exits.pool_drop_pct / 100) {
        return price / entryPrice - 1;
      }
    }

    // 2. Take profit
    if (exits.tp_pct !== undefined) {
      if (price >= entryPrice * (1 + exits.tp_pct / 100)) {
        return price / entryPrice - 1;
      }
    }

    // Track peak for trail and stall
    if (price > peak) {
      peak = price;
      lastHighMs = now;
    }

    // 3. Stall
    if (exits.stall_sec !== undefined) {
      const gap = (now - lastHighMs) / 1000;
      if (gap >= exits.stall_sec) {
        return price / entryPrice - 1;
      }
    }

    // 4. Stop
    if (exits.stop_pct !== undefined) {
      if (price <= entryPrice * (1 - exits.stop_pct / 100)) {
        return price / entryPrice - 1;
      }
    }

    // 5. Trail (arm at tp level)
    if (exits.trail_pct !== undefined) {
      const tpLevel = exits.tp_pct !== undefined
        ? entryPrice * (1 + exits.tp_pct / 100)
        : entryPrice * 1.15;
      if (!trailArmed && price >= tpLevel) {
        trailArmed = true;
      }
      if (trailArmed) {
        if (price > peak) peak = price;
        if (price <= peak * (1 - exits.trail_pct / 100)) {
          return price / entryPrice - 1;
        }
      }
    }

    // 6. Clock
    if (exits.clock_sec !== undefined) {
      const clockMs = ticks[0].observed_at_ms + exits.clock_sec * 1000;
      if (now >= clockMs) {
        return price / entryPrice - 1;
      }
    }
  }

  // 7. Window end — exit at last tick
  if (ticks.length > 0) {
    return ticks[ticks.length - 1].price_usd / entryPrice - 1;
  }
  return 0;
}

export async function runBacktest(recipe: CompiledRecipe, windowHours?: number) {
  const cutoffMs = Date.now() - (windowHours ?? 6) * 60 * 60 * 1000;
  const clocks = collectRecentClocks(cutoffMs);

  if (clocks.size === 0) {
    return { n: 0, median: 0, green: 0, rugs: 0, rugRate: 0 };
  }

  const returns: number[] = [];
  let rugs = 0;

  for (const [mint, clockInfo] of clocks.entries()) {
    if (clockInfo.pairAddress === null) continue;

    // Apply gates from migration row
    if (!applyGates(recipe, clockInfo.rawJson)) {
      continue;
    }

    // Entry with recipe delay
    const delayMs = (recipe.entry_delay_sec ?? 300) * 1000;
    const { entry, ticks } = getTicksForMint(
      mint,
      clockInfo.clockMs,
      clockInfo.pairAddress,
      delayMs
    );

    if (entry === null || ticks.length === 0) {
      continue;
    }

    const ret = scoreRecipeExit(recipe, entry.price_usd, ticks);
    returns.push(ret);

    if (ret <= -0.5) {
      rugs++;
    }
  }

  if (returns.length === 0) {
    return { n: 0, median: 0, green: 0, rugs: 0, rugRate: 0 };
  }

  const med = median(returns);
  const green = returns.filter(r => r > 0).length;
  const rugRate = rugs / returns.length;

  return {
    n: returns.length,
    median: med,
    green,
    rugs,
    rugRate,
  };
}
