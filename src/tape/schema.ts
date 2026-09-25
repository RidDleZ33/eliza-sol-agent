// Market recorder schema — v1
// Matches RECORDER_SCHEMA.md exactly. Do not deviate.
// Append-only. Two clocks. Full raw payload. No UPDATEs.

export const SCHEMA_VERSION = 1;

export function createSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      hostname TEXT,
      git_sha TEXT,
      schema_version INTEGER NOT NULL,
      config_json TEXT,
      stopped_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS market_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingest_run_id INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_endpoint TEXT,
      chain_id TEXT NOT NULL DEFAULT 'solana',
      mint TEXT NOT NULL,
      quote_mint TEXT,
      pair_address TEXT NOT NULL,
      dex_id TEXT,
      symbol TEXT,
      name TEXT,
      price_usd REAL,
      price_native REAL,
      liq_usd REAL,
      liq_base REAL,
      liq_quote REAL,
      fdv_usd REAL,
      mcap_usd REAL,
      vol_5m_usd REAL,
      vol_1h_usd REAL,
      vol_6h_usd REAL,
      vol_24h_usd REAL,
      tx_5m_buys INTEGER,
      tx_5m_sells INTEGER,
      tx_1h_buys INTEGER,
      tx_1h_sells INTEGER,
      tx_24h_buys INTEGER,
      tx_24h_sells INTEGER,
      change_5m_pct REAL,
      change_1h_pct REAL,
      change_6h_pct REAL,
      change_24h_pct REAL,
      pair_created_at TEXT,
      pair_created_at_ms INTEGER,
      boost_active INTEGER DEFAULT 0,
      has_socials INTEGER DEFAULT 0,
      socials_json TEXT,
      sol_usd REAL,
      universe_hint TEXT,
      raw_json TEXT,
      raw_sha256 TEXT,
      FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ticks_obs ON market_ticks(observed_at_ms);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ticks_mint_obs ON market_ticks(mint, observed_at_ms);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ticks_pair_obs ON market_ticks(pair_address, observed_at_ms);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ticks_source_obs ON market_ticks(source, observed_at_ms);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingest_run_id INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT,
      mint TEXT NOT NULL,
      quote_mint TEXT,
      pair_address TEXT,
      dex_id TEXT,
      pair_created_at_ms INTEGER,
      extra_json TEXT,
      tick_id INTEGER,
      FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id),
      FOREIGN KEY (tick_id) REFERENCES market_ticks(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_type_mint ON discovery_events(event_type, mint, pair_address, observed_at_ms);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_set_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingest_run_id INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      mint TEXT NOT NULL,
      pair_address TEXT,
      facts_json TEXT,
      watch_set_json TEXT,
      flow_1h_json TEXT,
      source TEXT,
      raw_json TEXT,
      facts_partial INTEGER DEFAULT 0,
      FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sol_marks (
      observed_at_ms INTEGER PRIMARY KEY,
      sol_usd REAL NOT NULL,
      source TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS recorder_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at_ms INTEGER NOT NULL,
      source TEXT,
      kind TEXT,
      message TEXT,
      extra_json TEXT
    );
  `);
}

export function seedSchemaMeta(db: any): void {
  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('tape_schema_version', '1');`);
}
