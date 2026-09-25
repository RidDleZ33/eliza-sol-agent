// DexScreener poller v1
// 1. Poll token-profiles/latest + latest boosts (public, 60/min)
// 2. For each Solana address, fetch /tokens/v1/solana/{mints} in batches (public 300/min)
// 3. Persist every pair on that token, not just the first

import { normalizeDexScreenerPair } from "../normalize";
import { shouldRecordFirstSeen, recordDiscoveryEvent, shouldRecordTrendingEnter } from "../discover";
import { getDb } from "../db";
import { SCHEMA_VERSION } from "../schema";

const DS_BASE = "https://api.dexscreener.com";

interface PollerResult {
  ticks: number;
  firstSeen: number;
  trending: number;
  errors: number;
}

let lastTrendingCheck: Map<string, number> = new Map();

export async function pollDexScreener(runId: number): Promise<PollerResult> {
  const db = getDb();
  const result: PollerResult = { ticks: 0, firstSeen: 0, trending: 0, errors: 0 };

  try {
    // Step 1: Get latest token profiles (new trending tokens)
    const profilesUrl = `${DS_BASE}/token-profiles/latest/v1?limit=25`;
    const profilesResp = await fetch(profilesUrl);
    if (!profilesResp.ok) {
      recordError("dexscreener", "http", `profiles: HTTP ${profilesResp.status}`, null);
      result.errors++;
    } else {
      const profiles = await profilesResp.json();
      if (Array.isArray(profiles)) {
        // Collect unique Solana mints
        const mints = new Set<string>();
        for (const p of profiles) {
          if (p.chainId === "solana" && p.tokenAddress) {
            mints.add(p.tokenAddress);
          }
        }

        // Step 2: Fetch token details in batches (max 15 at a time per docs)
        const mintArray = Array.from(mints);
        for (let i = 0; i < mintArray.length; i += 15) {
          const batch = mintArray.slice(i, i + 15);
          await pollTokenBatch(runId, batch, result, true);
        }
      }
    }
  } catch (err: any) {
    recordError("dexscreener", "http", `profiles error: ${err.message}`, null);
    result.errors++;
  }

  return result;
}

async function pollTokenBatch(
  runId: number,
  mints: string[],
  result: PollerResult,
  isTrending: boolean
) {
  const db = getDb();
  try {
    const url = `${DS_BASE}/latest/dex/tokens/${mints.join(",")}`;
    console.log(`[tape] polling ${mints.length} tokens: ${url.substring(0, 80)}...`);
    const resp = await fetch(url);

    if (resp.status === 429) {
      recordError("dexscreener", "rate_limit", "429 on token batch", JSON.stringify({ mints: mints.length }));
      result.errors++;
      return;
    }

    if (!resp.ok) {
      recordError("dexscreener", "http", `token batch: HTTP ${resp.status}`, JSON.stringify({ mints: mints.length }));
      result.errors++;
      return;
    }

    const data = await resp.json();
    if (!data || !data.pairs || !Array.isArray(data.pairs)) return;

    for (const pair of data.pairs) {
      if (!pair.pairAddress) continue;

      const mint = pair.baseToken?.address;
      if (!mint) continue;

      try {
        const tick = normalizeDexScreenerPair(pair, `/latest/dex/tokens/solana/${mint}`);

        // Insert tick (append-only)
        const tickId = insertTick(db, runId, tick);
        result.ticks++;

        // First seen?
        if (shouldRecordFirstSeen(mint, pair.pairAddress)) {
          recordDiscoveryEvent(runId, {
            event_type: "FIRST_SEEN",
            source: "dexscreener",
            mint: mint,
            quote_mint: tick.quote_mint,
            pair_address: pair.pairAddress,
            dex_id: tick.dex_id,
            pair_created_at_ms: tick.pair_created_at_ms,
            extra_json: null,
          });
          result.firstSeen++;
        }

        // Trending enter (throttled)
        if (isTrending && shouldRecordTrendingEnter(mint, pair.pairAddress)) {
          recordDiscoveryEvent(runId, {
            event_type: "TRENDING_ENTER",
            source: "dexscreener",
            mint: mint,
            quote_mint: tick.quote_mint,
            pair_address: pair.pairAddress,
            dex_id: tick.dex_id,
            pair_created_at_ms: tick.pair_created_at_ms,
            extra_json: null,
          });
          result.trending++;
        }
      } catch (err: any) {
        recordError("dexscreener", "parse", `tick insert: ${err.message}`, JSON.stringify({ pair: pair.pairAddress }));
        result.errors++;
      }
    }
  } catch (err: any) {
    recordError("dexscreener", "http", `batch error: ${err.message}`, null);
    result.errors++;
  }
}

function insertTick(db: any, runId: number, tick: any): number {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO market_ticks (
      ingest_run_id, schema_version, observed_at, observed_at_ms,
      source, source_endpoint, chain_id, mint, quote_mint, pair_address, dex_id,
      symbol, name, price_usd, price_native, liq_usd, liq_base, liq_quote,
      fdv_usd, mcap_usd, vol_5m_usd, vol_1h_usd, vol_6h_usd, vol_24h_usd,
      tx_5m_buys, tx_5m_sells, tx_1h_buys, tx_1h_sells, tx_24h_buys, tx_24h_sells,
      change_5m_pct, change_1h_pct, change_6h_pct, change_24h_pct,
      pair_created_at, pair_created_at_ms, boost_active, has_socials, socials_json,
      sol_usd, universe_hint, raw_json, raw_sha256
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  stmt.run(
    runId,
    SCHEMA_VERSION,
    new Date(now).toISOString(),
    now,
    tick.source,
    tick.source_endpoint,
    tick.chain_id,
    tick.mint,
    tick.quote_mint,
    tick.pair_address,
    tick.dex_id,
    tick.symbol,
    tick.name,
    tick.price_usd,
    tick.price_native,
    tick.liq_usd,
    tick.liq_base,
    tick.liq_quote,
    tick.fdv_usd,
    tick.mcap_usd,
    tick.vol_5m_usd,
    tick.vol_1h_usd,
    tick.vol_6h_usd,
    tick.vol_24h_usd,
    tick.tx_5m_buys,
    tick.tx_5m_sells,
    tick.tx_1h_buys,
    tick.tx_1h_sells,
    tick.tx_24h_buys,
    tick.tx_24h_sells,
    tick.change_5m_pct,
    tick.change_1h_pct,
    tick.change_6h_pct,
    tick.change_24h_pct,
    tick.pair_created_at,
    tick.pair_created_at_ms,
    tick.boost_active,
    tick.has_socials,
    tick.socials_json,
    null, // sol_usd - will be updated from sol_marks later if needed
    tick.universe_hint,
    tick.raw_json,
    tick.raw_sha256
  );

  return db.prepare("SELECT last_insert_rowid()").get().value;
}

export function recordError(source: string, kind: string, message: string, extra: string | null) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO recorder_errors (observed_at_ms, source, kind, message, extra_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(now, source, kind, message, extra);
}
