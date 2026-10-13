// DexScreener poller v1
// Polls token-profiles/latest AND token-boosts/latest
// Fetches pair data for each Solana mint.
// Writes market_ticks + discovery_events.
// Phase 15B: Keep writing pair ticks for 6h after mint leaves the board.
// Phase 15B2: Persist keepalive set; dedup keepalive fetches vs board pass.

import { normalizeDexScreenerPair } from "../normalize";
import { shouldRecordFirstSeen, recordDiscoveryEvent, shouldRecordTrendingEnter } from "../discover";
import { getDb } from "../db";
import { SCHEMA_VERSION } from "../schema";
import { appendTickToJsonl } from "../jsonl";
import { getGmgnApiKey, getSolanaRpcUrl } from "../../utils/env";

const DS_BASE = "https://api.dexscreener.com";
const KEEPALIVE_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIGRATIONS_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const MIGRATIONS_MAX_PER_POLL = 20;

function migrationsEnabled(): boolean {
  const v = process.env.TAPE_MIGRATIONS;
  return v === "1" || v === "true";
}

interface PollerResult {
  ticks: number;
  firstSeen: number;
  trending: number;
  errors: number;
}

// Mints we've seen on any board recently — used to continue ticking after leaving
const keepaliveMints = new Map<string, number>(); // mint -> last board sighting ms

export async function pollDexScreener(runId: number): Promise<PollerResult> {
  const db = getDb();
  const result: PollerResult = { ticks: 0, firstSeen: 0, trending: 0, errors: 0 };
  const thisPollBoardMints = new Set<string>();

  // Load persisted keepalive set from DB on first poll
  if (keepaliveMints.size === 0) {
    try {
      const rows = db.prepare("SELECT mint, last_seen_at_ms FROM keepalive_mints").all();
      for (const row of rows) {
        keepaliveMints.set(row.mint, row.last_seen_at_ms);
      }
      if (rows.length > 0) {
        console.log(`[tape] loaded ${rows.length} keepalive mints from DB`);
      }
    } catch (err: any) {
      console.log(`[tape] failed to load keepalive mints: ${err.message}`);
    }
  }

  try {
    // Step 1: Get latest token profiles
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

        // Update keepalive set
        const now = Date.now();
        for (const m of mints) {
          keepaliveMints.set(m, now);
          thisPollBoardMints.add(m);
        }

        // Step 2: Fetch token details in batches (max 15 at a time)
        const mintArray = Array.from(mints);
        for (let i = 0; i < mintArray.length; i += 15) {
          const batch = mintArray.slice(i, i + 15);
          await pollTokenBatch(runId, batch, result, true);
        }

        // Persist keepalive set to DB
        try {
          db.exec("BEGIN TRANSACTION;");
          db.exec("DELETE FROM keepalive_mints;");
          const stmt = db.prepare("INSERT INTO keepalive_mints (mint, last_seen_at_ms) VALUES (?, ?);");
          for (const [m, ts] of keepaliveMints) {
            stmt.run(m, ts);
          }
          db.exec("COMMIT;");
        } catch (err: any) {
          console.log(`[tape] failed to persist keepalive mints: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    recordError("dexscreener", "http", `profiles error: ${err.message}`, null);
    result.errors++;
  }

  // Step 3: Poll boosts separately (Phase 15B)
  // Collect Solana mints from boosts, fetch their pairs, same as profiles.
  try {
    const boostsUrl = `${DS_BASE}/token-boosts/latest/v1?limit=25`;
    const boostsResp = await fetch(boostsUrl);
    if (!boostsResp.ok) {
      recordError("dexscreener", "http", `boosts: HTTP ${boostsResp.status}`, null);
      result.errors++;
    } else {
      const boosts = await boostsResp.json();
      if (Array.isArray(boosts)) {
        const now = Date.now();
        const boostMints = new Set<string>();
        for (const b of boosts) {
          if (b.chainId === "solana" && b.tokenAddress) {
            keepaliveMints.set(b.tokenAddress, now);
            thisPollBoardMints.add(b.tokenAddress);
            boostMints.add(b.tokenAddress);
          }
        }

        // Fetch pair data for boosted mints in batches (same as profiles)
        const boostArray = Array.from(boostMints);
        for (let i = 0; i < boostArray.length; i += 15) {
          const batch = boostArray.slice(i, i + 15);
          await pollTokenBatch(runId, batch, result, true);
        }
      }
    }
  } catch (err: any) {
    recordError("dexscreener", "http", `boosts error: ${err.message}`, null);
    result.errors++;
  }

  // Step 4: Keepalive — poll pairs for mints that left the board but are within window
  // Only poll mints NOT already seen on this poll's board (dedup)
  try {
    const now = Date.now();
    const expired = new Set<string>();
    const keepaliveArray: string[] = [];

    for (const [mint, lastSeen] of keepaliveMints) {
      if (now - lastSeen > KEEPALIVE_MS) {
        expired.add(mint);
      } else if (now - lastSeen > 0 && !thisPollBoardMints.has(mint)) {
        // Still in window, not on this poll's board — keep ticking
        keepaliveArray.push(mint);
      }
    }

    // Remove expired
    for (const m of expired) {
      keepaliveMints.delete(m);
    }

    // Poll keepalive mints in batches
    for (let i = 0; i < keepaliveArray.length; i += 15) {
      const batch = keepaliveArray.slice(i, i + 15);
      await pollTokenBatch(runId, batch, result, false);
    }
  } catch (err: any) {
    recordError("dexscreener", "http", `keepalive error: ${err.message}`, null);
    result.errors++;
  }

  // Step 5: PumpSwap migrations from GMGN (Phase 17C)
  if (!migrationsEnabled()) {
    console.log("[tape] migrations off");
  } else {
    const gmgnApiKey = getGmgnApiKey();
    if (!gmgnApiKey) {
      console.log("[tape] migrations key missing");
    } else {
      try {
        const now = Date.now();
        const newMigrationMints: string[] = [];

        const timestampSecs = Math.floor(now / 1000);
        const clientId = `${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 10)}`;
        const trenchesUrl = new URL("https://openapi.gmgn.ai/v1/trenches");
        trenchesUrl.searchParams.set("timestamp", String(timestampSecs));
        trenchesUrl.searchParams.set("client_id", clientId);
        trenchesUrl.searchParams.set("chain", "sol");

        const resp = await fetch(trenchesUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-APIKEY": gmgnApiKey,
          },
          body: JSON.stringify({
            version: "v2",
            completed: {
              filters: ["offchain", "onchain"],
              launchpad_platform_v2: true,
              launchpad_platform: ["Pump.fun"],
              quote_address_type: [4, 5, 3, 1, 13, 0],
              limit: 50,
            },
          }),
        });

        if (resp.status === 429) {
          recordError("gmgn", "rate_limit", "429 on completed feed", null);
          result.errors++;
          return result;
        }

        if (!resp.ok) {
          let bodySnippet = "";
          try {
            const bodyText = await resp.text();
            bodySnippet = bodyText.slice(0, 200).replace(/\n/g, " ").trim();
          } catch {
            // ignore
          }
          const errMsg = `completed feed: HTTP ${resp.status} ${bodySnippet}`;
          console.log(`[tape] ${errMsg}`);
          recordError("gmgn", "http", errMsg, null);
          result.errors++;
          return result;
        }

        let body: any;
        try {
          body = await resp.json();
        } catch (err: any) {
          recordError("gmgn", "parse", `completed feed parse: ${err.message}`, null);
          result.errors++;
          return result;
        }

        const list = body?.data?.completed;
        const candidates = Array.isArray(list) ? list.length : 0;
        if (!Array.isArray(list)) {
          recordError("gmgn", "parse", "completed feed: no data.completed array", null);
          result.errors++;
          console.log(`[tape] migrations candidates=${candidates} new=0`);
          return result;
        }

        const MAX_AGE_MS = 6 * 60 * 60 * 1000;

        for (const item of list) {
          if (newMigrationMints.length >= MIGRATIONS_MAX_PER_POLL) break;

          const mint = item?.address;
          if (!mint) continue;

          // Clock: complete_timestamp if present, else open_timestamp (both unix seconds)
          let migrateTs: number | null = null;
          if (typeof item.complete_timestamp === "number") {
            migrateTs = item.complete_timestamp * 1000;
          } else if (typeof item.open_timestamp === "number") {
            migrateTs = item.open_timestamp * 1000;
          } else {
            continue;
          }

          if (now - migrateTs > MAX_AGE_MS) continue;

          try {
            const existing = db.prepare("SELECT mint FROM migrations WHERE mint = ?").get(mint);
            if (existing) continue;
          } catch (e: any) {
            recordError("gmgn", "db", `migrations check: ${e.message}`, JSON.stringify({ mint }));
            continue;
          }

          try {
            const migrationStmt = db.prepare(`
              INSERT INTO migrations (
                mint, pair_address, dex_id, quote_mint, observed_at, observed_at_ms,
                pair_created_at_ms, price_usd, liq_usd, mcap_usd, fdv_usd,
                tx_5m_buys, tx_5m_sells, vol_5m_usd, raw_json,
                top_holder_sol, pool_sol, nuke_ratio, unique_buyers_5m, same_slot_buyers
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            migrationStmt.run(
              mint,
              item.pair_address || null,
              "pumpswap",
              null,
              new Date(now).toISOString(),
              now,
              migrateTs,
              null,
              item.liquidity ? parseFloat(item.liquidity) : null,
              item.usd_market_cap ? parseFloat(item.usd_market_cap) : null,
              null,
              null,
              null,
              null,
              JSON.stringify(item),
              null, null, null, null, null
            );

            // After insert: compute nuke snapshot using the pair's price_native and liq_quote
            try {
              const pairUrl = `${DS_BASE}/latest/dex/pairs/${item.pair_address}`;
              const pairResp = await fetch(pairUrl);
              if (pairResp.ok) {
                const pairData = await pairResp.json();
                const pair = pairData?.pairs?.[0];
                if (pair) {
                  const tick = normalizeDexScreenerPair(pair, `/latest/dex/pairs/${item.pair_address}`);
                  const nuke = await getNukeSnapshot(mint, tick.price_native || 0, tick.liq_quote || 0);
                  const updateStmt = db.prepare(`
                    UPDATE migrations SET top_holder_sol=?, pool_sol=?, nuke_ratio=?, unique_buyers_5m=?, same_slot_buyers=? WHERE mint=?
                  `);
                  updateStmt.run(
                    nuke.top_holder_sol,
                    nuke.pool_sol,
                    nuke.nuke_ratio,
                    nuke.unique_buyers_5m,
                    nuke.same_slot_buyers,
                    mint
                  );
                }
              }
            } catch (e: any) {
              recordError("gmgn", "nuke_snapshot", `nuke snapshot failed: ${e.message}`, JSON.stringify({ mint }));
            }
          } catch (e: any) {
            recordError("gmgn", "db", `migrations insert: ${e.message}`, JSON.stringify({ mint }));
            continue;
          }

          if (!keepaliveMints.has(mint)) {
            keepaliveMints.set(mint, now);
          }
          newMigrationMints.push(mint);
        }

        console.log(`[tape] migrations candidates=${candidates} new=${newMigrationMints.length}`);

        if (newMigrationMints.length > 0) {
          for (let i = 0; i < newMigrationMints.length; i += 15) {
            const batch = newMigrationMints.slice(i, i + 15);
            await pollTokenBatch(runId, batch, result, false);
          }
        }
      } catch (err: any) {
        recordError("gmgn", "http", `completed feed error: ${err.message}`, null);
        result.errors++;
      }
    }
  }

  return result;
}

interface NukeSnapshot {
  top_holder_sol: number | null;
  pool_sol: number | null;
  nuke_ratio: number | null;
  unique_buyers_5m: number | null;
  same_slot_buyers: number | null;
}

async function getNukeSnapshot(
  mint: string,
  price_native: number,
  liq_quote_sol: number
): Promise<NukeSnapshot> {
  const rpcUrl = getSolanaRpcUrl();
  const result: NukeSnapshot = {
    top_holder_sol: null,
    pool_sol: null,
    nuke_ratio: null,
    unique_buyers_5m: null,
    same_slot_buyers: null,
  };

  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenLargestAccounts",
        params: [mint],
      }),
    });

    if (!resp.ok) {
      return result;
    }

    const data = await resp.json();
    const accounts = data?.result?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return result;
    }

    // First largest account (should not be the pool itself in most cases)
    // Token-2022 has amount as string, classic SPL has amount as number
    let topAmount = 0;
    if (typeof accounts[0].amount === "string") {
      topAmount = parseFloat(accounts[0].amount) / Math.pow(10, accounts[0].decimals);
    } else {
      topAmount = accounts[0].amount / Math.pow(10, accounts[0].decimals);
    }

    result.top_holder_sol = topAmount * price_native;
    result.pool_sol = liq_quote_sol;
    if (liq_quote_sol > 0) {
      result.nuke_ratio = result.top_holder_sol / result.pool_sol;
    }
  } catch {
    // RPC failed, leave fields null
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
      // Filter to Solana only
      if (pair.chainId !== "solana") continue;
      if (!pair.pairAddress) continue;

      const mint = pair.baseToken?.address;
      if (!mint) continue;

      try {
        const tick = normalizeDexScreenerPair(pair, `/latest/dex/tokens/${mint}`);

        // Insert tick (append-only)
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?)
        `);

        const now = Date.now();
        const insertResult = stmt.run(
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
          null, // sol_usd
          tick.universe_hint,
          tick.raw_json,
          tick.raw_sha256
        );

        const tickId = insertResult.lastInsertRowid;
        result.ticks++;

        // JSONL sidecar
        appendTickToJsonl({
          observed_at_ms: now,
          source: tick.source,
          mint: tick.mint,
          pair_address: tick.pair_address,
          price_native: tick.price_native,
          price_usd: tick.price_usd,
          liq_quote: tick.liq_quote,
          raw_json: tick.raw_json,
          raw_sha256: tick.raw_sha256,
        });

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
            tick_id: tickId,
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
            tick_id: tickId,
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

export function recordError(source: string, kind: string, message: string, extra: string | null) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO recorder_errors (observed_at_ms, source, kind, message, extra_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(now, source, kind, message, extra);
}
