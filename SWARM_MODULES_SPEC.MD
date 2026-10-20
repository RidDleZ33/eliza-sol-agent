# Modules

Supersedes the 2026-09 swarm module spec. See README.md and PROJECT_SPEC.MD.

| Module | Path | State |
|---|---|---|
| Watchlist | `src/services/WatchlistService.ts` | Live. SQLite. Ingest writes rows; evaluators read them. |
| Ingest | `src/services/ingestion/` | Live. One watcher per feed, registered, flag-gated. |
| mig_edge | migrations watcher | Live. Own filter. Parallel to profiles and boosts. |
| Alpha | `src/evaluators/AlphaNarrativeEvaluator.ts` | Live. Score only. Social-unknown is dissent. |
| Beta | `src/evaluators/BetaContractEvaluator.ts` | Live. Facts. Does not size. |
| Gamma | `src/evaluators/GammaConsensusEvaluator.ts` | Live. Regime label. Does not sell or swap. |
| Exits | `src/services/PositionManagerService.ts` | Live. TP, stop, trail, clock, pool-drop. No partials. |
| Execution | `src/services/TradeExecutionService.ts` | Live. Jupiter. Dry-run default. Risk caps in code. |
| Operator | `src/services/TelegramAdminBot.ts` | Live. `/status`, `/book`, `/gamma`, halt. Poll restarts itself. |
| Tape | `src/tape/` | Live as a separate process. Migrations on. Day files. |
| Replay / grid | `src/replay/`, `src/tape/migrationGrid.ts` | Present. Promote rule is holdout median, not MFE. |
| Entitlements | `src/entitlements/tier.ts` | Hook only. `operator` runs the executor. |
| Eliza plugins | `src/plugins/`, `characters/` | Not the boot path. |

Not built: create-stream snipe, Helius wallet webhook as a pass, GMGN execution, partial sells, multi-user graph UI.
