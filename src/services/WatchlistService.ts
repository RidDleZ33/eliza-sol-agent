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
  unrealized_pnl_usd: number;
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
    unrealized_pnl_usd: number;
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
      "UPDATE watched_tokens SET status = ?, beta_decision = ?, beta_confidence = ?, beta_security_score = ?, beta_mint_disabled = ?, beta_freeze_disabled = ?, beta_reasons = ?, last_updated = CURRENT_TIMESTAMP WHERE mint_address = ?"
    );
    stmt.run(
      status,
      verdict.decision,
      verdict.confidenceRatio,
      verdict.securityScore,
      verdict.isMintDisabled ? 1 : 0,
      verdict.isFreezeDisabled ? 1 : 0,
      verdict.reasons.join("; "),
      mintAddress
    );

    logger.info("WATCHLIST", "updateTokenBetaVerdict", "Beta verdict stored", {
      mint: mintAddress,
      decision: verdict.decision,
      confidence: verdict.confidenceRatio,
      securityScore: verdict.securityScore,
      mintDisabled: verdict.isMintDisabled,
      freezeDisabled: verdict.isFreezeDisabled,
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
      const pnlUsd = (pnlPct / 100) * (pos.amount_sol * entryPrice);
      totalUnrealizedPnlUsd += pnlUsd;

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
        unrealized_pnl_usd: pnlUsd,
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
        unrealized_pnl_usd: parseFloat(totalUnrealizedPnlUsd.toFixed(2)),
        realized_pnl_usd: parseFloat(totalRealizedPnlUsd.toFixed(2)),
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