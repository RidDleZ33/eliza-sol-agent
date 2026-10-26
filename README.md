# eliza-sol-agent

RidSolBot. Solana paper desk. Code owns size, sell, and swap. A local model only scores or labels.

ElizaOS is not on the hot path. `ELIZA_BOOT=0`. Alpha, Beta, and Gamma are evaluators on a stub runtime, not a committee that votes a trade through.

## What it does

Ingest is one flag per feed. The live book is Dex profiles, Dex boosts, and `mig_edge` (Pump.fun migrations after the 5-minute clock). Each source has its own entry filter. Slots and size stay shared.

- Alpha scores narrative. Unknown social is dissent, not a pass, and does not auto-open a buy.
- Beta writes contract and watch-set facts.
- Gamma writes regime commentary. It does not set size, sell, or swap.
- `PositionManagerService` owns exits: take-profit, stop, trail, optional clock, and a pool-drop exit. No partial sells.
- Telegram is the operator surface: status, book, per-token gamma, daily-loss halt. The long-poll restarts itself.
- A separate tape process records pair ticks and migration rows. It does not buy.

Dry-run is the default. Live mode fails closed if the boot interlock does not pass.

## mig_edge

Clock is a Pump.fun completed migration from GMGN trenches. Entry is the first tick at or after clock + 5 minutes.

Live filter: liquidity $25k–$100k, holders >= 500, top-10 and creator present. A nuke-ratio band was tried and removed after it lost. Pool SOL drop is an exit, not an entry cut.

`CLOCK_SEC_MIG_EDGE` overrides the global clock for this source only. Profiles and boosts stay on `EXIT_CLOCK_SEC`.

## Exits

- Take-profit, stop, trail.
- `EXIT_CLOCK_SEC` default 0. Other exits still win if they fire first.
- `POOL_DROP_PCT` default 30. Sell when PumpSwap quote liquidity drops that far from entry, before the price stop. 0 turns it off.

## What it is not

- A create-stream snipe, or a buy inside the first five minutes after migration.
- GMGN as an execution venue. Candles for the desk are Dex, with Birdeye or GMGN OHLCV behind a flag.
- Public smart-money or KOL count as a pass.
- A model that picks size or the exit.

## Tape

`bun run tape`. Day files `data/tape/tape-YYYY-MM-DD.sqlite`. Keepalive hours default 1 (`TAPE_KEEPALIVE_HOURS`). Grid and replay must use `discoverTapeFiles`, not a single `tape.sqlite`. Migrations dedup is per day file. Score the migration pair only.

Promote rule: holdout median event-time PnL, n >= 30, two weeks. MFE is a column, not the rule. A tape result never writes `.env`.

Nuke ratio, top-5 holder ratio, and same-slot buyers are tape columns. They are not live cuts.

## Layout

```
src/index.ts                          services-only boot
src/services/ingestion/               one watcher per feed
src/services/PositionManagerService.ts
src/services/TradeExecutionService.ts Jupiter route; dry-run does not send
src/services/TelegramAdminBot.ts
src/evaluators/                       Alpha score, Beta facts, Gamma labels
src/tape/                             recorder, day files, migrations, grid
src/replay/                           event-time replay
src/entitlements/tier.ts              operator | desk | feed | free
```

## Run

```bash
bun install
cp .env.example .env
bun run start          # desk. dry-run unless you flip it
bun run tape           # recorder. separate process. no buys
bun run tape:migrations
bun run tape:grid
bun run web          # web API on localhost:3000
bun test
```

`./swarm.sh` and `./tape.sh` hardcode `/home/user/eliza-sol-agent`. Prefer the bun scripts unless that path is this machine.

`ENTITLEMENT_TIER` below `operator` exits before the executor. Tiers are hooks, not a product.

## Config that matters

See `.env.example`. Do not commit `.env` or `data/`.

- `DRY_RUN` and `DRY_RUN_MODE`. If they disagree, dry-run wins.
- `MAX_TRADE_SIZE_SOL`, `MAX_DEPLOYED_SOL`, `MAX_DAILY_LOSS_SOL`, `KILL_SWITCH`.
- `INGEST_*`, one flag per feed. `SOCIAL_BIRDEYE_LINKS` and `PA_BIRDEYE_OHLCV` default off.
- `EXIT_CLOCK_SEC`, `CLOCK_SEC_MIG_EDGE`, `POOL_DROP_PCT`.
- `TAPE_MIGRATIONS`, `TAPE_KEEPALIVE_HOURS`.
- LLM is OpenAI-compatible (`OPENAI_BASE_URL`, `MODEL_NAME`). Missing social does not require a Twitter bearer.

## Status

Master `a657cc5` (2026-10-20). Paper book is the control. Sub-minute stops are the leak. Pool-drop is the exit under test for that. Nuke ratio and same-slot buyers are tape columns, not live cuts.
