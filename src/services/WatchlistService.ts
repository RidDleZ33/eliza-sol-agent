import Database from "better-sqlite3";
import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  getMaxTrendingTokens,
  getMaxTopTraders,
} from "../utils/env.ts";

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
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watched_tokens (
        mint_address TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        narrative_score REAL DEFAULT 0.0,
        volume_24h REAL,
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
          `INSERT INTO watched_tokens 
           (mint_address, symbol, narrative_score, volume_24h, added_by_agent, added_at, last_updated)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
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
      console.error(`Failed to add token ${token.mint_address}:`, e);
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
      console.log(
        `Pruning lowest-scoring token: ${lowest.mint_address}`
      );
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
          `INSERT INTO watched_traders 
           (wallet_address, label, win_rate_7d, pnl_7d_usd, added_by_agent, added_at, last_updated)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
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
      console.error(`Failed to add trader ${trader.wallet_address}:`, e);
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
      console.log(
        `Pruning lowest-performing trader: ${lowest.wallet_address}`
      );
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
        `INSERT INTO positions (mint_address, symbol, buy_tx_signature, entry_price_usd, amount_sol, status, entered_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', CURRENT_TIMESTAMP)`
      )
      .run(mintAddress, symbol, buyTxSignature, entryPriceUsd, amountSol);
  }

  async updatePositionStatus(mintAddress: string, status: string, exitPriceUsd?: number, realizedPnl?: number, sellTxSignature?: string) {
    this.db
      .prepare(
        `UPDATE positions SET status = ?, exit_price_usd = COALESCE(?, exit_price_usd), realized_pnl_usd = COALESCE(?, realized_pnl_usd), sell_tx_signature = COALESCE(?, sell_tx_signature), closed_at = ? WHERE mint_address = ? AND status = 'OPEN'`
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

  getDb() {
    return this.db;
  }

  close() {
    this.db.close();
  }
}

export const watchlistService = new WatchlistService();

export default watchlistService;