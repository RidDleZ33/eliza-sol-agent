# Market recorder — schema lock

Status: **LOCKED for first tape** (v1)  
Date: 2026-09-24  
Purpose: record everything a later event-time backtest needs so a week of data is not trash.

This is **not** the trading blotter (`trades` / `trade_events`).  
This is the **market tape** the replay clock will read.

If you change a column meaning after recording starts, bump `schema_version` and **do not reuse the name**. Add a column. Never overwrite history.

---

## Rules that keep a week valid

1. **Append-only.** Snapshots are new rows. Never `UPDATE` a tick to “fix” price.
2. **Two clocks on every row.**  
   - `observed_at` = our wall clock when the process wrote the row (ISO + unix_ms).  
   - `source_ts` = timestamp the vendor claims, if any (nullable).  
   - `pair_created_at` = vendor/chain pool create time (nullable).  
   Replay uses `observed_at` as “what we could have known.” `pair_created_at` is age, not first sighting.
3. **Keep the raw payload.** Extracted columns are convenience. `raw_json` is how we backfill a field we forgot.
4. **Identity is mint + pair + quote.** Same mint can have many pairs. Record all; replay can pick primary later.
5. **Do not compute Alpha/Beta/Gamma into this DB.** Features can be derived later from columns + raw. If you store a derived score, tag `derived=1` and the code version.
6. **No look-ahead writes.** Do not patch yesterday’s row with today’s holder count.
7. **schema_version + ingest_run_id on every row.**
8. **SQLite now, export later.** WAL mode. Daily backup copy. Optional JSONL sidecar for the same ticks (cheap insurance if the db corrupts).

DexScreener public API has **no** historical new-pairs archive. This recorder *is* next month’s history.

---

## Files

Suggested (keep out of git):

```text
data/tape/tape.sqlite
data/tape/ticks-YYYY-MM-DD.jsonl.gz    # optional sidecar
data/tape/backups/tape-YYYY-MM-DD.sqlite
```

`.gitignore`: `data/tape/`, `*.sqlite`, `*.db`.

---

## Tables

### `schema_meta`

| Column | Type | Notes |
|---|---|---|
| key | TEXT PK | e.g. `tape_schema_version` |
| value | TEXT | `1` |

Seed: `tape_schema_version = 1`.

### `ingest_runs`

One row per process start.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| started_at | TEXT | ISO |
| started_at_ms | INTEGER | |
| hostname | TEXT | |
| git_sha | TEXT | nullable |
| schema_version | INTEGER | 1 |
| config_json | TEXT | poll seconds, sources enabled, rpc url host only (no keys) |
| stopped_at | TEXT | nullable |

### `market_ticks`

Periodic **as-of** snapshot of a pair we can see. This is the main tape.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| ingest_run_id | INTEGER | FK |
| schema_version | INTEGER | 1 |
| observed_at | TEXT | ISO UTC |
| observed_at_ms | INTEGER | |
| source | TEXT | `dexscreener` \| `birdeye` \| `gecko` \| `helius` \| `manual` |
| source_endpoint | TEXT | path or label, not secrets |
| chain_id | TEXT | `solana` |
| mint | TEXT | base mint |
| quote_mint | TEXT | usually SOL or USDC |
| pair_address | TEXT | |
| dex_id | TEXT | `raydium` \| `pumpswap` \| `orca` \| `meteora` \| `pumpfun` \| … |
| symbol | TEXT | |
| name | TEXT | |
| price_usd | REAL | nullable |
| price_native | REAL | price in quote (SOL) |
| liq_usd | REAL | |
| liq_base | REAL | |
| liq_quote | REAL | quote units (SOL if quote is SOL) |
| fdv_usd | REAL | |
| mcap_usd | REAL | |
| vol_5m_usd | REAL | |
| vol_1h_usd | REAL | |
| vol_6h_usd | REAL | |
| vol_24h_usd | REAL | |
| tx_5m_buys | INTEGER | |
| tx_5m_sells | INTEGER | |
| tx_1h_buys | INTEGER | |
| tx_1h_sells | INTEGER | |
| tx_24h_buys | INTEGER | |
| tx_24h_sells | INTEGER | |
| change_5m_pct | REAL | |
| change_1h_pct | REAL | |
| change_6h_pct | REAL | |
| change_24h_pct | REAL | |
| pair_created_at | TEXT | vendor pool create, ISO, nullable |
| pair_created_at_ms | INTEGER | |
| boost_active | INTEGER | 0/1 |
| has_socials | INTEGER | 0/1 if any website/twitter/telegram on profile |
| socials_json | TEXT | `{"twitter":..,"telegram":..,"website":..}` |
| sol_usd | REAL | SOL mark at observe time (for later PnL) |
| universe_hint | TEXT | `LAUNCH` \| `TREND_24H` \| `UNKNOWN` — heuristic at observe, not gospel |
| raw_json | TEXT | **full vendor payload** |
| raw_sha256 | TEXT | dedup / integrity |

Indexes:

```sql
CREATE INDEX idx_ticks_obs ON market_ticks(observed_at_ms);
CREATE INDEX idx_ticks_mint_obs ON market_ticks(mint, observed_at_ms);
CREATE INDEX idx_ticks_pair_obs ON market_ticks(pair_address, observed_at_ms);
CREATE INDEX idx_ticks_source_obs ON market_ticks(source, observed_at_ms);
```

Do **not** unique-constraint (mint, observed_at). Two sources can tick the same second.

### `discovery_events`

Discrete “this entered a universe / we saw it for the first time.” Replay clock starts here.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| ingest_run_id | INTEGER | |
| schema_version | INTEGER | |
| observed_at | TEXT | |
| observed_at_ms | INTEGER | |
| event_type | TEXT | see enum below |
| source | TEXT | |
| mint | TEXT | |
| quote_mint | TEXT | |
| pair_address | TEXT | |
| dex_id | TEXT | |
| pair_created_at_ms | INTEGER | nullable |
| extra_json | TEXT | e.g. wallet that bought, filter that fired |
| tick_id | INTEGER | nullable FK to the snapshot that accompanied this event |

**event_type enum (v1):**

| Type | Meaning |
|---|---|
| `FIRST_SEEN` | first time this process saw this mint+pair |
| `PROFILE_SEEN` | Dex profile/boost/socials packet |
| `TRENDING_ENTER` | appeared on a trending/boost/new-pairs poll |
| `TRENDING_EXIT` | dropped off that list (optional) |
| `FILTER_TREND_24H` | first time 24h vol/change/liq cleared configured floors |
| `WALLET_BUY` | watched pubkey bought (v1 can be unused) |
| `WALLET_SELL` | watched pubkey sold |
| `MANUAL` | operator pasted mint |

Unique enough: index `(event_type, mint, pair_address, observed_at_ms)`.

### `watch_set_snapshots` (v1 table exists, writer can no-op)

Do not skip creating it. Empty is fine. Adding the table later is easy; forgetting the *idea* is how Beta intel never gets a tape.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| ingest_run_id | INTEGER | |
| schema_version | INTEGER | |
| observed_at | TEXT | |
| observed_at_ms | INTEGER | |
| mint | TEXT | |
| pair_address | TEXT | |
| facts_json | TEXT | mint/freeze/lp/top10_real when you have them |
| watch_set_json | TEXT | array of `{pubkey,role,pct,last_action,...}` |
| flow_1h_json | TEXT | |
| source | TEXT | `rpc` \| `rugcheck` \| `birdeye` |
| raw_json | TEXT | |
| facts_partial | INTEGER | 1 if history-unavailable / incomplete |

### `sol_marks`

Thin series so we do not depend on a tick to know SOL/USD.

| Column | Type | Notes |
|---|---|---|
| observed_at_ms | INTEGER PK | |
| sol_usd | REAL | |
| source | TEXT | |

### `recorder_errors`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| observed_at_ms | INTEGER | |
| source | TEXT | |
| kind | TEXT | `http` \| `parse` \| `rpc` \| `rate_limit` |
| message | TEXT | |
| extra_json | TEXT | |

If the tape has a silent hour, this table tells you whether the market died or the poller died.

---

## v1 pollers (minimum to start tonight)

Do not wait for Birdeye/Helius to start the clock.

1. **DexScreener token-profiles / boosts / search or token batch** you already use in Alpha ingest. Every payload → `market_ticks` + raw_json.
2. On each mint+pair first time in *this* sqlite → `discovery_events.FIRST_SEEN`.
3. If it appears on a “new/trending/boost” list → `TRENDING_ENTER`.
4. Every N minutes write `sol_marks` (Dex SOL/USDC pair or your PriceService).
5. Log HTTP failures into `recorder_errors`.

Cadence: 15–30s for hot lists is enough for a first tape. Do not hammer public API past published limits. Dedup in-process: if raw_sha256 for that pair is unchanged, you may skip a tick **or** still write a tick (storage vs fidelity). **Prefer write** for the first week; disk is cheaper than a hole.

---

## What would invalidate a week (avoid these)

- Updating old ticks in place when a later API is “better.”
- Storing only “best pair” and dropping other pools.
- Storing price without `observed_at` vs `pair_created_at` confusion (age vs knowledge).
- No `raw_json` (cannot backfill `tx_5m_buys` later).
- Mixing paper fills into this file.
- Rotating the sqlite without a date in the backup name.
- Recording in local TZ without Zulu.

---

## What we are *not* recording in v1 (on purpose)

- Full trade-by-trade prints (needs paid archive / later Helius). Replay v1 uses tick OHLC-ish snapshots; fill model = next tick price ± slippage vs `liq_quote`.
- Historical holders as-of T (APIs are “now”). `watch_set_snapshots` waits until a paid RPC walk exists; `facts_partial=1` until then.
- LLM completions (those belong on watchlist / blotter, not the market tape).
- Private keys, Telegram tokens, full RPC URL with key.

---

## Backtest mapping (so we do not forget why columns exist)

| Replay need | Tape source |
|---|---|
| When could we have seen this name | `discovery_events` `FIRST_SEEN` / `TRENDING_ENTER` |
| Age of pool | `pair_created_at_ms` |
| Features at T | latest `market_ticks` with `observed_at_ms <= T` |
| Fill price | next tick `price_native` / `price_usd` |
| Slippage proxy | `liq_quote` at T |
| Launch vs trend split | `universe_hint` + event_type + age at T |
| SOL PnL | `sol_marks` |
| Hole in tape | gap in `observed_at_ms` + `recorder_errors` |

---

## Migration policy after v1

Allowed without bumping meaning: `ALTER TABLE ... ADD COLUMN` nullable.  
Forbidden: rename, change units (USD vs native), delete columns, backfill by overwriting.

Next likely adds (do not block v1): `slot`, `bonding_progress`, `graduated_at`, `holder_count`.
