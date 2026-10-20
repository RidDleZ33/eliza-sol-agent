# Desk spec

Operator desk for Solana pairs, plus a separate tape used to test one entry rule at a time. Updated 2026-10-20 against master `a657cc5`.

The 2026-09 committee spec (Eliza swarm, unanimous vote, Jito bundle as the product) is retired. Those files still exist under `src/plugins/` and `characters/`. They are not the boot path.

## Roles

| Name | Owns | Does not own |
|---|---|---|
| Ingest | Flag-gated watchers writing the watchlist | Pass / fail |
| Alpha | Narrative score via `LlmClient` | Buy, size |
| Beta | Contract and watch-set facts | Buy, size |
| Gamma | Regime label for the operator | Size, sell, swap |
| mig_edge | Own entry filter on Pump.fun migrations | Slots, size, other sources |
| Position manager | TP, stop, trail, clock, pool-drop | Partial sells (not implemented) |
| Execution | Jupiter route, dry-run or live, risk caps | LLM text as a size |
| Tape | Event-time pair rows and migration facts, no orders | Applying the live filter (ingest does that) |

Social-unknown is dissent plus `used_fallback`. It is not an automatic pass into a buy.

## Boot

`src/index.ts` starts services directly. `ELIZA_BOOT=1` is not implemented. Entitlement `operator` is required to stay up; lower tiers exit. Crash recovery runs before watchers. Telegram starts before ingest when token and chat id are set, and relaunches the poll if it dies. Beta ticks on the interval even if Alpha is backlogged; Alpha is single-flight via `requestAlphaTick`.

## Risk and exits

Caps are env, read in code: trade size, deployed SOL, daily loss, kill switch. Daily-loss halt posts to Telegram (throttled) and journals a row. Dry-run disagreement fails closed.

Pool-drop sells when PumpSwap quote liquidity drops `POOL_DROP_PCT` from entry, before the price stop. Clock can be global or overridden per source (`CLOCK_SEC_MIG_EDGE`).

## Tape and promote rule

Recorder: `bun run tape`. Day files under `data/tape/`. Keepalive hours default 1. Score the migration pair only.

Promote a cell only if holdout median PnL beats the current desk rule, n >= 30, two weeks in a row. Do not promote on MFE. A tape result never writes `.env`.

## Explicitly out

Create-stream snipes. Buys inside five minutes of migrate. GMGN as an execution venue. Public wallet-follow as a pass. Gamma writing the score. One week of tape, or a cell under 30 names.
