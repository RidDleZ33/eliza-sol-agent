// Phase 15F: write Gamma decisions to tape (fire-and-forget)
// Gated by TAPE_DECISIONS=true. Opens its own connection; never blocks evaluator.

import { existsSync } from "fs";
import { dayFilePath } from "./filelist";
import { getTapeDecisions } from "../utils/env";

const Database = require("better-sqlite3");

let logOnce = false;

function log(msg: string) {
  if (!logOnce) {
    console.log(`[tape:decisions] ${msg}`);
    logOnce = true;
  }
}

export interface DecisionInput {
  mint: string;
  observed_at_ms: number;
  decision: string;
  reason: string;
  conviction: number;
  bar_count?: number | null;
  interval?: string | null;
  vwap_ratio?: number | null;
  peak_pct?: number | null;
  ema?: string | null;
  buy_sell?: number | null;
  liq_usd?: number | null;
  pair_age_min?: number | null;
}

export function writeDecision(dec: DecisionInput): void {
  if (!getTapeDecisions()) return;

  // Fire-and-forget: don't await, don't throw back to caller
  try {
    const path = dayFilePath(new Date().toISOString().slice(0, 10));
    if (!existsSync(path)) {
      log(`tape file ${path} not found; skipping decision`);
      return;
    }

    const conn = new Database(path);
    conn.pragma("journal_mode = WAL");
    conn.pragma("busy_timeout = 2000");

    // Ensure table exists with source and conviction columns (phase 15F)
    conn.exec(`CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      source TEXT,
      conviction REAL,
      bar_count INTEGER,
      interval TEXT,
      vwap_ratio REAL,
      peak_pct REAL,
      ema TEXT,
      buy_sell REAL,
      liq_usd REAL,
      pair_age_min INTEGER
    );`);
    conn.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_mint_obs ON decisions(mint, observed_at_ms);`);

    // Add missing columns for older schema
    try {
      const cols = conn.prepare("PRAGMA table_info(decisions)").all();
      const names = new Set(cols.map((c: any) => c.name));
      if (!names.has("source")) conn.exec("ALTER TABLE decisions ADD COLUMN source TEXT;");
      if (!names.has("conviction")) conn.exec("ALTER TABLE decisions ADD COLUMN conviction REAL;");
    } catch {
      // ignore pragma errors
    }

    const stmt = conn.prepare(`
      INSERT INTO decisions (
        mint, observed_at, observed_at_ms, decision, reason,
        source, conviction,
        bar_count, interval, vwap_ratio, peak_pct, ema, buy_sell, liq_usd, pair_age_min
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      dec.mint,
      new Date(dec.observed_at_ms).toISOString(),
      dec.observed_at_ms,
      dec.decision,
      dec.reason,
      "gamma",
      dec.conviction,
      dec.bar_count ?? null,
      dec.interval ?? null,
      dec.vwap_ratio ?? null,
      dec.peak_pct ?? null,
      dec.ema ?? null,
      dec.buy_sell ?? null,
      dec.liq_usd ?? null,
      dec.pair_age_min ?? null
    );

    conn.close();
  } catch (e: any) {
    log(`failed to write decision for ${dec.mint}: ${e.message}`);
  }
}
