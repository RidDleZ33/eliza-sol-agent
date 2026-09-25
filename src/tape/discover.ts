// Discovery events: FIRST_SEEN and TRENDING_ENTER
// FIRST_SEEN: first time (mint, pair_address) appears in this db
// TRENDING_ENTER: appears on trending/boost list (throttle to avoid spam)

import { getDb } from "./db";
import { SCHEMA_VERSION } from "./schema";

export interface DiscoveryEvent {
  event_type: string;
  source: string;
  mint: string;
  quote_mint: string | null;
  pair_address: string;
  dex_id: string | null;
  pair_created_at_ms: number | null;
  extra_json: string | null;
  tick_id?: number;
}

export function shouldRecordFirstSeen(mint: string, pairAddress: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM discovery_events
    WHERE event_type = 'FIRST_SEEN' AND mint = ? AND pair_address = ?
  `).get(mint, pairAddress);
  return row.cnt === 0;
}

export function shouldRecordTrendingEnter(mint: string, pairAddress: string): boolean {
  const db = getDb();
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM discovery_events
    WHERE event_type = 'TRENDING_ENTER' AND mint = ? AND pair_address = ?
    AND observed_at_ms > ?
  `).get(mint, pairAddress, sixHoursAgo);
  return row.cnt === 0;
}

export function recordDiscoveryEvent(runId: number, ev: DiscoveryEvent) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO discovery_events (
      ingest_run_id, schema_version, observed_at, observed_at_ms,
      event_type, source, mint, quote_mint, pair_address, dex_id,
      pair_created_at_ms, extra_json, tick_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    runId,
    SCHEMA_VERSION,
    new Date(now).toISOString(),
    now,
    ev.event_type,
    ev.source,
    ev.mint,
    ev.quote_mint,
    ev.pair_address,
    ev.dex_id,
    ev.pair_created_at_ms,
    ev.extra_json,
    ev.tick_id || null
  );
}
