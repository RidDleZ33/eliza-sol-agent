import Database from "better-sqlite3";
import type { BetaVerdict } from "../evaluators/BetaContractEvaluator.ts";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  getMaxTrendingTokens,
  getMaxTopTraders,
} from "../utils/env.ts";
import { logger } from "./LoggerService.ts";
import { configService } from "./ConfigService.ts";


export interface WatchedToken {
  mint_address: string;
  symbol: string;
  narrative_score: number;
  volume_24h: number;
  added_by_agent: string;
  added_at: string;
  last_updated: string;
}

export interface WatchedTokenInput {
  mint_address: string;
  symbol: string;
  narrative_score: number;
  volume_24h: number;
  added_by_agent: string;
}

export interface WatchedTrader {
  wallet_address: string;
  label: string;
  win_rate_7d: number;
  pnl_7d_usd: number;
  added_by_agent: string;
  added_at: string;
  last_updated: string;
}

export interface WatchedTraderInput {
  wallet_address: string;
  label: string;
  win_rate_7d: number;
  pnl_7d_usd: number;
  added_by_agent: string;
}

export interface JournalEntry {
  position_id?: number;
  mint_address: string;
  symbol: string;
  event_type: "BUY_INTENT" | "BUY_EXECUTED" | "BUY_FAILED" | "STOP_LOSS_UPDATED" | "SELL_EXECUTED" | "PRUNED";
  price_usd?: number;
  amount_sol?: number;
  conviction_score?: number;
  reason?: string;
  tx_signature?: string;
}

export interface PositionMetric {
  id: number;
  mint_address: string;
  symbol: string;
  amount_sol: number;
  entry_price_usd: number;
  peak_price_usd: number;
  current_price_usd: number;
  unrealized_pnl_sol: number;
  unrealized_pnl_pct: number;
  drop_from_peak_pct: number;
  trailing_stop_level_usd: number;
  trailing_tier: string;
  entered_at: string;
  buy_tx_signature: string;
}

export interface DashboardMetrics {
  portfolio: {
    active_positions_count: number;
    max_positions: number;
    total_sol_deployed: number;
    unrealized_pnl_sol: number;
    realized_pnl_usd: number;
    win_rate_pct: number;
    total_trades_closed: number;
  };
  positions: PositionMetric[];
  pipeline: {
    pending_alpha: number;
    alpha_passed: number;
    beta_passed: number;
    evaluating: number;
  };
  recent_journal: any[];
}

const DB_PATH = join(__dirname, "../../.eliza/watchlist.db");

class WatchlistService {
  private db: Database.Database;
  private maxTokens: number;
  private maxTraders: number;

  constructor() {
    const dbDir = join(__dirname, "../../.eliza");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.maxTokens = getMaxTrendingTokens();
    this.maxTraders = getMaxTopTraders();

    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();
    this.migrateSchema();
  }

  private migrateSchema() {
    try {
      const columns = this.db.prepare("PRAGMA table_info(watched_tokens)").all() as any[];
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('alpha_decision')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_decision TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_decision column");
      }
      if (!columnNames.has('alpha_confidence')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_confidence REAL");
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_confidence column");
      }
      if (!columnNames.has('alpha_narrative_score')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_narrative_score REAL");
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_narrative_score column");
      }
      if (!columnNames.has('alpha_organicity_score')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_organicity_score REAL");
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_organicity_score column");
      }
      if (!columnNames.has('alpha_category')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_category TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_category column");
      }
      if (!columnNames.has('alpha_reasoning')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_reasoning TEXT");
      }
      if (!columnNames.has('beta_decision')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_decision TEXT");
      }
      if (!columnNames.has('beta_confidence')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_confidence REAL");
      }
      if (!columnNames.has('beta_security_score')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_security_score REAL");
      }
      if (!columnNames.has('beta_mint_disabled')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_mint_disabled INTEGER DEFAULT 0");
      }
      if (!columnNames.has('beta_freeze_disabled')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_freeze_disabled INTEGER DEFAULT 0");
      }
      if (!columnNames.has('beta_reasons')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_reasons TEXT");
      }
      if (!columnNames.has('alpha_used_fallback')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN alpha_used_fallback INTEGER DEFAULT 0");
      }

      // Phase 2A: trades journal table (append-only tape of attempts)
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_order_id TEXT UNIQUE,
            mint TEXT NOT NULL,
            symbol TEXT,
            side TEXT NOT NULL,
            mode TEXT NOT NULL,
            qty_raw TEXT,
            sol_in REAL,
            sol_out REAL,
            px_quote REAL,
            px_mark REAL,
            tx_sig TEXT,
            status TEXT NOT NULL,
            reason TEXT,
            created_at INTEGER NOT NULL
          )
        `);
        logger.info("WATCHLIST", "migrateSchema", "trades journal table ready");
      } catch (e: any) {
        logger.warn("WATCHLIST", "migrateSchema", "trades table creation failed", { error: e.message });
      }

      // Position price tracking columns
      const positionColumns = this.db.prepare("PRAGMA table_info(positions)").all() as any[];
      const positionColumnNames = new Set(positionColumns.map(c => c.name));

      if (!positionColumnNames.has('current_price_usd')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN current_price_usd REAL DEFAULT 0");
        logger.info("WATCHLIST", "migrateSchema", "Added current_price_usd column to positions");
      }
      if (!positionColumnNames.has('unrealized_pnl_usd')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN unrealized_pnl_usd REAL DEFAULT 0");
        logger.info("WATCHLIST", "migrateSchema", "Added unrealized_pnl_usd column to positions");
      }
      if (!positionColumnNames.has('unrealized_pnl_pct')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN unrealized_pnl_pct REAL DEFAULT 0");
        logger.info("WATCHLIST", "migrateSchema", "Added unrealized_pnl_pct column to positions");
      }
      if (!positionColumnNames.has('last_updated')) {
        this.db.exec("ALTER TABLE positions ADD COLUMN last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
        logger.info("WATCHLIST", "migrateSchema", "Added last_updated column to positions");
      }

      // Phase 3C: add beta_top10_pct column to watched_tokens
      const watchedColumns = this.db.prepare("PRAGMA table_info(watched_tokens)").all() as any[];
      const watchedColumnNames = new Set(watchedColumns.map(c => c.name));
      if (!watchedColumnNames.has('beta_top10_pct')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN beta_top10_pct REAL DEFAULT 0");
        logger.info("WATCHLIST", "migrateSchema", "Added beta_top10_pct column to watched_tokens");
      }
      if (!watchedColumnNames.has('gamma_last_decision')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_decision TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_decision column");
      }
      if (!watchedColumnNames.has('gamma_last_conviction')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_conviction REAL");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_conviction column");
      }
      if (!watchedColumnNames.has('gamma_last_reasons')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_reasons TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_reasons column");
      }
      if (!watchedColumnNames.has('gamma_last_pa_json')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_pa_json TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_pa_json column");
      }
      if (!watchedColumnNames.has('gamma_last_hv')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_hv REAL");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_hv column");
      }
      if (!watchedColumnNames.has('gamma_last_regime')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_regime TEXT");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_regime column");
      }
      if (!watchedColumnNames.has('gamma_last_at')) {
        this.db.exec("ALTER TABLE watched_tokens ADD COLUMN gamma_last_at INTEGER");
        logger.info("WATCHLIST", "migrateSchema", "Added gamma_last_at column");
      }
    } catch (e: any) {
      console.error(`[WATCHLIST][migrateSchema] Migration failed: ${e.message}`);
    }
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watched_tokens (
        mint_address TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        narrative_score REAL DEFAULT 0.5,
        volume_24h REAL,
        status TEXT DEFAULT 'PENDING_ALPHA',
        eval_count INTEGER DEFAULT 0,
        next_eval_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        prune_reason TEXT,
        added_by_agent TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS watched_traders (
        wallet_address TEXT PRIMARY KEY,
        label TEXT,
        win_rate_7d REAL,
        pnl_7d_usd REAL,
        added_by_agent TEXT,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint_address TEXT NOT NULL,
        symbol TEXT,
        buy_tx_signature TEXT,
        sell_tx_signature TEXT,
        entry_price_usd REAL DEFAULT 0,
        exit_price_usd REAL DEFAULT 0,
        realized_pnl_usd REAL DEFAULT 0,
        amount_sol REAL DEFAULT 0,
        status TEXT DEFAULT 'OPEN',
        peak_price_usd REAL DEFAULT 0,
        entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS config_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        category TEXT,
        description TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trade_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER,
        mint_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        event_type TEXT NOT NULL,
        price_usd REAL DEFAULT 0,
        amount_sol REAL DEFAULT 0,
        conviction_score REAL DEFAULT 0,
        reason TEXT,
        tx_signature TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Token Methods
  async getWatchedTokens(): Promise<WatchedToken[]> {
    return this.db
      .prepare("SELECT * FROM watched_tokens ORDER BY narrative_score DESC")
      .all() as WatchedToken[];
  }

  /**
   * Insert a newly discovered token into the watchlist ONLY if not already tracked.
   * This is the unbiased discovery entry point for the Ingestion Manager.
   */
  async addDiscoveredToken(mintAddress: string, symbol: string, volume24h: number, source?: string): Promise<boolean> {
    try {
      const existing = this.db
        .prepare("SELECT mint_address FROM watched_tokens WHERE mint_address = ?")
        .get(mintAddress);

      if (existing) {
        // Already tracked - just update volume but preserve all state
        this.db
          .prepare("UPDATE watched_tokens SET volume_24h = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?")
          .run(volume24h, mintAddress);
        return false;
      }

      const addedBy = source || "ingestion_manager";
      this.db
        .prepare(
          "INSERT INTO watched_tokens (mint_address, symbol, narrative_score, volume_24h, status, added_by_agent) VALUES (?, ?, 0.5, ?, 'PENDING_ALPHA', ?)"
        )
        .run(mintAddress, symbol, volume24h, addedBy);

      logger.info("WATCHLIST", "addDiscoveredToken", "New token discovered", { mint: mintAddress, symbol, volume24h, addedBy });
      return true;
    } catch (e) {
      logger.error("WATCHLIST", "addDiscoveredToken", "Failed to add token", { mint: mintAddress, error: e.message });
      return false;
    }
  }

  /**
   * Get tokens ready for Alpha narrative evaluation.
   * Selects tokens that are PENDING_ALPHA, DEFERRED (past eval time), or need re-evaluation.
   * Uses datetime() for proper ISO vs SQLite timestamp comparison.
   * Preserves Alpha's ability to intentionally defer tokens to future times.
   */
  async getTokensForAlphaEvaluation(): Promise<WatchedToken[]> {
    return this.db
      .prepare("SELECT * FROM watched_tokens WHERE status IN ('PENDING_ALPHA', 'DEFERRED') AND datetime(next_eval_at) <= datetime('now')")
      .all() as WatchedToken[];
  }

  /**
   * Update a token's Alpha narrative evaluation verdict.
   */
  async updateTokenAlphaVerdict(
    mintAddress: string,
    verdict: {
      decision: string;
      confidenceRatio: number;
      narrativeScore: number;
      organicityScore: number;
      narrativeCategory: string;
      reasoning: string;
      used_fallback: boolean;
    }
  ): Promise<void> {
    // PASS and DISSENT both proceed to Beta; only FAIL blocks it
    const status = (verdict.decision === 'PASS' || verdict.decision === 'DISSENT') ? 'ALPHA_PASSED' : 'ALPHA_FAILED';

    const stmt = this.db.prepare(
      "UPDATE watched_tokens SET status = ?, narrative_score = ?, alpha_decision = ?, alpha_confidence = ?, alpha_narrative_score = ?, alpha_organicity_score = ?, alpha_category = ?, alpha_reasoning = ?, alpha_used_fallback = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
    );
    stmt.run(
      status,
      verdict.narrativeScore,
      verdict.decision,
      verdict.confidenceRatio,
      verdict.narrativeScore,
      verdict.organicityScore,
      verdict.narrativeCategory,
      verdict.reasoning,
      verdict.used_fallback ? 1 : 0,
      mintAddress
    );

    logger.info("WATCHLIST", "updateTokenAlphaVerdict", "Alpha verdict stored", {
      mint: mintAddress,
      decision: verdict.decision,
      confidence: verdict.confidenceRatio,
      narrative: verdict.narrativeScore,
      organicity: verdict.organicityScore,
      category: verdict.narrativeCategory,
      reasoning: verdict.reasoning
    });
  }

  /**
   * Get tokens that passed Alpha narrative evaluation and are ready for Beta contract forensics.
   */
  async getTokensForBetaEvaluation(): Promise<WatchedToken[]> {
    return this.db
      .prepare("SELECT * FROM watched_tokens WHERE status = 'ALPHA_PASSED'")
      .all() as WatchedToken[];
  }

    /**
   * Get candidate tokens that have completed both Alpha and Beta evaluations,
   * regardless of binary status, for Gamma committee consensus synthesis.
   */
  async getTokensForGammaConsensus(): Promise<WatchedToken[]> {
    return this.db
      .prepare(`
        SELECT * FROM watched_tokens 
        WHERE alpha_decision IS NOT NULL 
          AND beta_decision IS NOT NULL 
          AND status IN ('BETA_PASSED', 'ALPHA_PASSED')
          AND datetime(next_eval_at) <= datetime('now')
      `)
      .all() as WatchedToken[];
  }


  /**
   * Get tokens that have passed both Alpha narrative and Beta contract evaluation.
   * These are the only tokens eligible for trading by Gamma.
   */
  async getTokensForTrading(): Promise<WatchedToken[]> {
    return this.db
      .prepare("SELECT * FROM watched_tokens WHERE status = 'BETA_PASSED'")
      .all() as WatchedToken[];
  }

  /**
   * Update a token's status in the state machine.
   */
  /**
   * Store Beta contract forensics verdict for a token.
   */
  async updateTokenBetaVerdict(mintAddress: string, verdict: BetaVerdict): Promise<void> {
    const status = (verdict.decision === 'PASS' || verdict.decision === 'DISSENT') ? 'BETA_PASSED' : 'BETA_FAILED';

    const stmt = this.db.prepare(
      "UPDATE watched_tokens SET status = ?, beta_decision = ?, beta_confidence = ?, beta_security_score = ?, beta_mint_disabled = ?, beta_freeze_disabled = ?, beta_reasons = ?, beta_top10_pct = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
    );
    stmt.run(
      status,
      verdict.decision,
      verdict.confidenceRatio,
      verdict.securityScore,
      verdict.isMintDisabled ? 1 : 0,
      verdict.isFreezeDisabled ? 1 : 0,
      verdict.reasons.join("; "),
      verdict.top10ConcentrationPct,
      mintAddress
    );

    logger.info("WATCHLIST", "updateTokenBetaVerdict", "Beta verdict stored", {
      mint: mintAddress,
      decision: verdict.decision,
      confidence: verdict.confidenceRatio,
      securityScore: verdict.securityScore,
      mintDisabled: verdict.isMintDisabled,
      freezeDisabled: verdict.isFreezeDisabled,
      top10ConcentrationPct: verdict.top10ConcentrationPct,
      reasons: verdict.reasons.join("; ")
    });
  }

  async updateTokenStatus(mintAddress: string, status: string, score?: number, pruneReason?: string): Promise<void> {
    const stmt = this.db.prepare(
      "UPDATE watched_tokens SET status = ?, narrative_score = COALESCE(?, narrative_score), prune_reason = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
    );
    stmt.run(status, score, pruneReason, mintAddress);

    logger.info("WATCHLIST", "updateTokenStatus", "Token status updated", { mint: mintAddress, status, score, pruneReason });
  }

  /**
   * Defer a token for re-evaluation after a delay.
   * This allows Alpha to intentionally set future evaluation times.
   */
  async deferToken(mintAddress: string, delayMinutes: number): Promise<void> {
    const nextEval = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    const stmt = this.db.prepare(
      "UPDATE watched_tokens SET status = 'DEFERRED', eval_count = eval_count + 1, next_eval_at = ? WHERE mint_address = ?"
    );
    stmt.run(nextEval, mintAddress);

    logger.info("WATCHLIST", "deferToken", "Token deferred", { mint: mintAddress, delayMinutes, nextEval });
  }

  /**
   * Phase 2A: append-only trades journal row. Used for dry-run PAPER entries and
   * live FILLED/FAILED entries with tx sigs.
   */
  async logTradeRow(trade: {
    clientOrderId: string;
    mint: string;
    symbol: string;
    side: "BUY" | "SELL";
    mode: "DRY_RUN" | "LIVE";
    qtyRaw?: string;
    solIn?: number;
    solOut?: number;
    pxQuote?: number;
    pxMark?: number;
    txSig?: string;
    status: "QUOTED" | "FILLED" | "FAILED" | "PAPER";
    reason?: string;
  }): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO trades
          (client_order_id, mint, symbol, side, mode, qty_raw, sol_in, sol_out,
           px_quote, px_mark, tx_sig, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        trade.clientOrderId,
        trade.mint,
        trade.symbol,
        trade.side,
        trade.mode,
        trade.qtyRaw ?? null,
        trade.solIn ?? null,
        trade.solOut ?? null,
        trade.pxQuote ?? null,
        trade.pxMark ?? null,
        trade.txSig ?? null,
        trade.status,
        trade.reason ?? null,
        Date.now()
      );

      // Phase 2C: notify moved to TradeExecutionService to break circular import.
      // WatchlistService no longer imports TelegramAdminBot.

      return result.lastInsertRowid as number;
    } catch (e: any) {
      logger.error("WATCHLIST", "logTradeRow", "Failed to write trade row", {
        clientOrderId: trade.clientOrderId,
        status: trade.status,
        error: e.message,
      });
      return -1;
    }
  }

  /**
   * Phase 2A: helper for later Telegram admin use.
   */
  listRecentTrades(limit = 20): any[] {
    return this.db
      .prepare("SELECT * FROM trades ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  /**
   * Phase 2C: filtered blotter query.
   */
  /**
   * Phase 11A: Save last Gamma consensus snapshot for a token.
   */
  async saveGammaSnapshot(
    mint: string,
    decision: string,
    conviction: number,
    reasons: string[],
    pa: object | null,
    hv: number | null,
    regime: string | null
  ): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        UPDATE watched_tokens SET
          gamma_last_decision = ?,
          gamma_last_conviction = ?,
          gamma_last_reasons = ?,
          gamma_last_pa_json = ?,
          gamma_last_hv = ?,
          gamma_last_regime = ?,
          gamma_last_at = ?
        WHERE mint_address = ?
      `);
      stmt.run(
        decision,
        conviction,
        reasons.join("; "),
        pa ? JSON.stringify(pa) : null,
        hv,
        regime,
        Date.now(),
        mint
      );
    } catch (e: any) {
      logger.error("WATCHLIST", "saveGammaSnapshot", "Failed to save gamma snapshot", {
        mint,
        error: e.message,
      });
    }
  }

  /**
   * Phase 11A: Get last Gamma consensus snapshot for a token.
   */
  getGammaSnapshot(mint: string): any | null {
    try {
      const row = this.db
        .prepare(`
          SELECT symbol,
            gamma_last_decision AS decision,
            gamma_last_conviction AS conviction,
            gamma_last_reasons AS reasons,
            gamma_last_pa_json AS pa_json,
            gamma_last_hv AS hv,
            gamma_last_regime AS regime,
            gamma_last_at AS at
          FROM watched_tokens
          WHERE mint_address = ?
        `)
        .get(mint);
      if (!row) return null;
      let pa = null;
      if (row.pa_json) {
        try {
          pa = JSON.parse(row.pa_json);
        } catch (e) {
          // bad JSON, treat as null
        }
      }
      return {
        symbol: row.symbol,
        decision: row.decision,
        conviction: row.conviction,
        reasons: row.reasons,
        pa,
        hv: row.hv,
        regime: row.regime,
        at: row.at,
      };
    } catch (e: any) {
      logger.error("WATCHLIST", "getGammaSnapshot", "Failed to get gamma snapshot", {
        mint,
        error: e.message,
      });
      return null;
    }
  }

  /**
   * Phase 11A: List recent gamma snapshots for /gamma command.
   */
  listGammaSnapshots(limit = 8): any[] {
    try {
      const rows = this.db
        .prepare(`
          SELECT symbol, mint_address,
            gamma_last_decision AS decision,
            gamma_last_conviction AS conviction,
            gamma_last_pa_json AS pa_json,
            gamma_last_hv AS hv,
            gamma_last_regime AS regime,
            gamma_last_at AS at
          FROM watched_tokens
          WHERE gamma_last_at IS NOT NULL
          ORDER BY gamma_last_at DESC
          LIMIT ?
        `)
        .all(limit);
      // Parse pa_json for each row
      return rows.map(row => {
        let pa = null;
        if (row.pa_json) {
          try {
            pa = JSON.parse(row.pa_json);
          } catch (e) {
            // bad JSON, treat as null
          }
        }
        return {
          ...row,
          pa,
        };
      });
    } catch (e: any) {
      logger.error("WATCHLIST", "listGammaSnapshots", "Failed to list gamma snapshots", {
        error: e.message,
      });
      return [];
    }
  }

  listTrades(opts?: { mint?: string; side?: string; mode?: string; status?: string; limit?: number }): any[] {
    let sql = "SELECT * FROM trades WHERE 1=1";
    const params: any[] = [];
    if (opts?.mint) { sql += " AND mint = ?"; params.push(opts.mint); }
    if (opts?.side) { sql += " AND side = ?"; params.push(opts.side); }
    if (opts?.mode) { sql += " AND mode = ?"; params.push(opts.mode); }
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts?.limit ?? 10);
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Phase 2C: status histogram for blotter.
   */
  countTradesByStatus(): { PAPER: number; FILLED: number; FAILED: number; QUOTED: number } {
    const rows = this.db.prepare("SELECT status, COUNT(*) as cnt FROM trades GROUP BY status").all();
    const out = { PAPER: 0, FILLED: 0, FAILED: 0, QUOTED: 0 };
    for (const r of rows) {
      if (r.status in out) out[r.status] = r.cnt;
    }
    return out;
  }

  /**
   * Phase 2C: total SOL across OPEN positions.
   */
  openExposureSol(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount_sol),0) as total FROM positions WHERE status='OPEN'").get();
    return row.total;
  }

  /**
   * Log an audit event to the trade journal
   */
  async logTradeJournal(entry: JournalEntry): Promise<void> {
    try {
      this.db
        .prepare(
          "INSERT INTO trade_journal (position_id, mint_address, symbol, event_type, price_usd, amount_sol, conviction_score, reason, tx_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          entry.position_id || null,
          entry.mint_address,
          entry.symbol,
          entry.event_type,
          entry.price_usd || 0,
          entry.amount_sol || 0,
          entry.conviction_score || 0,
          entry.reason || "",
          entry.tx_signature || ""
        );
    } catch (e: any) {
      logger.error("WATCHLIST", "logTradeJournal", "Failed to write journal entry", { error: e.message });
    }
  }

  /**
   * Complete view of all trade states, open positions, candidate pipeline, and journal audit history.
   */
  async getCompleteTradeState(): Promise<any> {
    const openPositions = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all();
    const closedPositions = this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED' ORDER BY closed_at DESC LIMIT 20").all();
    const recentJournal = this.db.prepare("SELECT * FROM trade_journal ORDER BY created_at DESC LIMIT 50").all();
    const pendingCandidates = this.db.prepare("SELECT * FROM watched_tokens WHERE status IN ('PENDING_ALPHA', 'ALPHA_PASSED', 'BETA_PASSED', 'DEFERRED')").all();

    return {
      activePositionsCount: openPositions.length,
      openPositions,
      closedPositions,
      pendingCandidatesCount: pendingCandidates.length,
      pendingCandidates,
      journalAuditTrail: recentJournal,
    };
  }

  async addToken(token: WatchedTokenInput): Promise<boolean> {
    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM watched_tokens")
      .get() as { count: number };

    if (count.count >= this.maxTokens) {
      this.pruneLowestToken();
    }

    try {
      this.db
        .prepare(
          "INSERT INTO watched_tokens (mint_address, symbol, narrative_score, volume_24h, added_by_agent, added_at, last_updated) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        )
        .run(
          token.mint_address,
          token.symbol,
          token.narrative_score,
          token.volume_24h,
          token.added_by_agent
        );
      return true;
    } catch (e) {
      logger.error("WATCHLIST", "WatchlistService", "Failed to add token", { mint: token.mint_address, error: e.message });
      return false;
    }
  }

  async updateTokenScore(mint: string, score: number): Promise<void> {
    this.db
      .prepare(
        "UPDATE watched_tokens SET narrative_score = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
      )
      .run(score, mint);
  }

  async removeToken(mint: string): Promise<void> {
    this.db
      .prepare("DELETE FROM watched_tokens WHERE mint_address = ?")
      .run(mint);
  }

  private pruneLowestToken() {
    const lowest = this.db
      .prepare(
        "SELECT mint_address FROM watched_tokens ORDER BY narrative_score ASC, added_at ASC LIMIT 1"
      )
      .get();

    if (lowest) {
      logger.info("WATCHLIST", "WatchlistService", "Pruning lowest-scoring token", { mint: lowest.mint_address });
      this.db
        .prepare("DELETE FROM watched_tokens WHERE mint_address = ?")
        .run(lowest.mint_address);
    }
  }

  // Trader Methods
  async getWatchedTraders(): Promise<WatchedTrader[]> {
    return this.db
      .prepare("SELECT * FROM watched_traders ORDER BY win_rate_7d DESC")
      .all() as WatchedTrader[];
  }

  async addTrader(trader: WatchedTraderInput): Promise<boolean> {
    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM watched_traders")
      .get() as { count: number };

    if (count.count >= this.maxTraders) {
      this.pruneLowestTrader();
    }

    try {
      this.db
        .prepare(
          "INSERT INTO watched_traders (wallet_address, label, win_rate_7d, pnl_7d_usd, added_by_agent, added_at, last_updated) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        )
        .run(
          trader.wallet_address,
          trader.label,
          trader.win_rate_7d,
          trader.pnl_7d_usd,
          trader.added_by_agent
        );
      return true;
    } catch (e) {
      logger.error("WATCHLIST", "WatchlistService", "Failed to add trader", { wallet: trader.wallet_address, error: e.message });
      return false;
    }
  }

  async removeTrader(wallet: string): Promise<void> {
    this.db
      .prepare("DELETE FROM watched_traders WHERE wallet_address = ?")
      .run(wallet);
  }

  private pruneLowestTrader() {
    const lowest = this.db
      .prepare(
        "SELECT wallet_address FROM watched_traders ORDER BY win_rate_7d ASC, pnl_7d_usd ASC, added_at ASC LIMIT 1"
      )
      .get();

    if (lowest) {
      logger.info("WATCHLIST", "WatchlistService", "Pruning lowest-performing trader", { wallet: lowest.wallet_address });
      this.db
        .prepare("DELETE FROM watched_traders WHERE wallet_address = ?")
        .run(lowest.wallet_address);
    }
  }

  // Position Methods
  // Phase 2A: risk.ts calls getActivePositions(); provide as alias for getOpenPositions().
  async getActivePositions(isDryRun?: boolean): Promise<any[]> {
    return this.getOpenPositions(isDryRun);
  }

  getActivePositionsCount(): number {
    return this.db
      .prepare("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'")
      .get().count;
  }

  async getOpenPositions(isDryRun?: boolean): Promise<any[]> {
    if (isDryRun === true) {
      // Only return dry run positions (tx signatures start with DRY_RUN_BUY_)
      return this.db
        .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND buy_tx_signature LIKE 'DRY_RUN_BUY_%'")
        .all();
    }
    if (isDryRun === false) {
      // Only return live positions (tx signatures do NOT start with DRY_RUN_)
      return this.db
        .prepare("SELECT * FROM positions WHERE status = 'OPEN' AND buy_tx_signature NOT LIKE 'DRY_RUN_%'")
        .all();
    }
    // Return all open positions
    return this.db
      .prepare("SELECT * FROM positions WHERE status = 'OPEN'")
      .all();
  }

  async addPosition(mintAddress: string, symbol: string, buyTxSignature: string, entryPriceUsd: number, amountSol: number) {
    this.db
      .prepare(
        "INSERT INTO positions (mint_address, symbol, buy_tx_signature, entry_price_usd, amount_sol, status, entered_at) VALUES (?, ?, ?, ?, ?, 'OPEN', CURRENT_TIMESTAMP)"
      )
      .run(mintAddress, symbol, buyTxSignature, entryPriceUsd, amountSol);
  }

  async updatePositionStatus(mintAddress: string, status: string, exitPriceUsd?: number, realizedPnl?: number, sellTxSignature?: string) {
    this.db
      .prepare(
        "UPDATE positions SET status = ?, exit_price_usd = COALESCE(?, exit_price_usd), realized_pnl_usd = COALESCE(?, realized_pnl_usd), sell_tx_signature = COALESCE(?, sell_tx_signature), closed_at = ? WHERE mint_address = ? AND status = 'OPEN'"
      )
      .run(status, exitPriceUsd, realizedPnl, sellTxSignature, new Date().toISOString(), mintAddress);
  }

  async closePosition(mintAddress: string, sellTxSignature: string) {
    await this.updatePositionStatus(mintAddress, "CLOSED", undefined, undefined, sellTxSignature);
  }

  async updatePeakPrice(mintAddress: string, peakPriceUsd: number) {
    this.db
      .prepare("UPDATE positions SET peak_price_usd = ? WHERE mint_address = ?")
      .run(peakPriceUsd, mintAddress);
  }

  async updatePositionPrice(
    mintAddress: string,
    currentPriceUsd: number,
    unrealizedPnlUsd: number,
    unrealizedPnlPct: number
  ) {
    this.db
      .prepare(
        "UPDATE positions SET current_price_usd = ?, unrealized_pnl_usd = ?, unrealized_pnl_pct = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
      )
      .run(currentPriceUsd, unrealizedPnlUsd, unrealizedPnlPct, mintAddress);
  }

  async removePosition(mintAddress: string) {
    this.db
      .prepare("DELETE FROM positions WHERE mint_address = ?")
      .run(mintAddress);
  }

  async hasPosition(mintAddress: string): Promise<boolean> {
    const result = this.db
      .prepare("SELECT COUNT(*) as count FROM positions WHERE mint_address = ? AND status = 'OPEN'")
      .get(mintAddress);
    return result.count > 0;
  }

  /**
   * Generates comprehensive metrics for Telegram Admin Dashboard
   */
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    const openPositions = this.db.prepare("SELECT * FROM positions WHERE status = 'OPEN'").all() as any[];
    const closedPositions = this.db.prepare("SELECT * FROM positions WHERE status = 'CLOSED'").all() as any[];
    const recentJournal = this.db.prepare("SELECT * FROM trade_journal ORDER BY created_at DESC LIMIT 5").all() as any[];

    // Pipeline counts
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM watched_tokens
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const countMap: Record<string, number> = {};
    counts.forEach(c => countMap[c.status] = c.count);

    // Calculate Realized Stats
    let totalRealizedPnlUsd = 0;
    let winningTrades = 0;
    closedPositions.forEach((pos) => {
      const pnl = pos.realized_pnl_usd || 0;
      totalRealizedPnlUsd += pnl;
      if (pnl > 0) winningTrades++;
    });

    const totalClosed = closedPositions.length;
    const winRatePct = totalClosed > 0 ? (winningTrades / totalClosed) * 100 : 0;

    // Calculate Active Positions & Live Unrealized PnL
    let totalSolDeployed = 0;
    let totalUnrealizedPnlUsd = 0;
    const positionMetrics: PositionMetric[] = [];

    for (const pos of openPositions) {
      totalSolDeployed += pos.amount_sol || 0;

      // Use cached current price from position updates
      let currentPrice = pos.current_price_usd || pos.entry_price_usd || 0;

      const entryPrice = pos.entry_price_usd || currentPrice;
      const peakPrice = Math.max(pos.peak_price_usd || entryPrice, currentPrice);

      const pnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
      const pnlSol = entryPrice > 0 ? pos.amount_sol * ((currentPrice - entryPrice) / entryPrice) : 0;
      totalUnrealizedPnlUsd += pnlSol;

      const dropFromPeakPct = peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0;

      // Determine Dynamic Trailing Stop Level & Active Tier
      let stopPriceUsd = entryPrice * 0.88; // Hard -12% Stop
      let trailingTier = "HARD_STOP (-12%)";

      if (pnlPct >= 100) {
        stopPriceUsd = peakPrice * 0.90; // Dynamic -10% from peak
        trailingTier = "TIER_3 (+100% / Trail -10%)";
      } else if (pnlPct >= 50) {
        stopPriceUsd = peakPrice * 0.85; // Dynamic -15% from peak
        trailingTier = "TIER_2 (+50% / Trail -15%)";
      } else if (pnlPct >= 25) {
        stopPriceUsd = entryPrice * 1.02; // Breakeven +2%
        trailingTier = "TIER_1 (Breakeven +2%)";
      }

      positionMetrics.push({
        id: pos.id,
        mint_address: pos.mint_address,
        symbol: pos.symbol,
        amount_sol: pos.amount_sol,
        entry_price_usd: entryPrice,
        peak_price_usd: peakPrice,
        current_price_usd: currentPrice,
        unrealized_pnl_sol: pnlSol,
        unrealized_pnl_pct: pnlPct,
        drop_from_peak_pct: dropFromPeakPct,
        trailing_stop_level_usd: stopPriceUsd,
        trailing_tier: trailingTier,
        entered_at: pos.entered_at,
        buy_tx_signature: pos.buy_tx_signature || "N/A",
      });
    }

    const maxPositions = configService.getNumber("MAX_CONCURRENT_POSITIONS");

    return {
      portfolio: {
        active_positions_count: openPositions.length,
        max_positions: maxPositions,
        total_sol_deployed: parseFloat(totalSolDeployed.toFixed(3)),
        unrealized_pnl_sol: parseFloat(totalUnrealizedPnlUsd.toFixed(4)),
        realized_pnl_usd: parseFloat(totalRealizedPnlUsd.toFixed(4)),
        win_rate_pct: parseFloat(winRatePct.toFixed(1)),
        total_trades_closed: totalClosed,
      },
      positions: positionMetrics,
      pipeline: {
        pending_alpha: countMap["PENDING_ALPHA"] || 0,
        alpha_passed: countMap["ALPHA_PASSED"] || 0,
        beta_passed: countMap["BETA_PASSED"] || 0,
        evaluating: countMap["GAMMA_EVALUATING"] || 0,
      },
      recent_journal: recentJournal,
    };
  }

  getDb(): Database.Database {
    return this.db;
  }

  close() {
    this.db.close();
  }
}

export const watchlistService = new WatchlistService();

export default watchlistService;