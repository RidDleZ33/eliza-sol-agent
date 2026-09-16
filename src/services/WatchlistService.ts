import Database from "better-sqlite3";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  getMaxTrendingTokens,
  getMaxTopTraders,
} from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

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
        logger.info("WATCHLIST", "migrateSchema", "Added alpha_reasoning column");
      }
    } catch (e) {
      logger.error("WATCHLIST", "migrateSchema", "Migration failed", { error: e.message });
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
  async addDiscoveredToken(mintAddress: string, symbol: string, volume24h: number): Promise<boolean> {
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

      this.db
        .prepare(
          "INSERT INTO watched_tokens (mint_address, symbol, narrative_score, volume_24h, status, added_by_agent) VALUES (?, ?, 0.5, ?, 'PENDING_ALPHA', 'ingestion_manager')"
        )
        .run(mintAddress, symbol, volume24h);

      logger.info("WATCHLIST", "addDiscoveredToken", "New token discovered", { mint: mintAddress, symbol, volume24h });
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
    }
  ): Promise<void> {
    // PASS and DISSENT both proceed to Beta; only FAIL blocks it
    const status = (verdict.decision === 'PASS' || verdict.decision === 'DISSENT') ? 'ALPHA_PASSED' : 'ALPHA_FAILED';

    const stmt = this.db.prepare(
      "UPDATE watched_tokens SET status = ?, narrative_score = ?, alpha_decision = ?, alpha_confidence = ?, alpha_narrative_score = ?, alpha_organicity_score = ?, alpha_category = ?, alpha_reasoning = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
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
  getActivePositionsCount(): number {
    return this.db
      .prepare("SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'")
      .get().count;
  }

  async getOpenPositions(): Promise<any[]> {
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

  async updatePeakPrice(mintAddress: string, peakPriceUsd: number) {
    this.db
      .prepare("UPDATE positions SET peak_price_usd = ? WHERE mint_address = ?")
      .run(peakPriceUsd, mintAddress);
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

  getDb(): Database.Database {
    return this.db;
  }

  close() {
    this.db.close();
  }
}

export const watchlistService = new WatchlistService();

export default watchlistService;