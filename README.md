# eliza-sol-agent

Multi-agent AI trading swarm on Solana using [ElizaOS](https://elizaos.ai). Three autonomous agents (Alpha, Beta, Gamma) collaborate through a consensus engine to evaluate, validate, and execute trades.

- **Alpha (Narrative Scout):** Discovers trending tokens via DexScreener, CoinGecko, top trader wallets, and social sentiment.
- **Beta (Contract Forensics Analyst):** Analyzes token contracts for rug-pull risks, holder concentration, liquidity, and market manipulation.
- **Gamma (Execution Trader):** Executes trades via Jupiter swap routes and Jito bundles after consensus approval.

## Architecture

```
ingestion/ (Alpha) → consensus/ (all three) → trading-execution/ (Gamma)
     ▲                       │                        │
     └───────────────────────┴────────────────────────┘
              (bidirectional messaging via ElizaOS runtime)
```

### Plugin Dependencies

**Critical:** The Jupiter plugin must be explicitly registered with Gamma in the swarm configuration. Without it, Gamma's `execute_trade` action fails because the `JUPITER_SERVICE` runtime service is never resolved.

In `src/index.ts`:
```typescript
const swarm = new Swarm([
  { character: alphaCharacter, plugins: [watchlistPlugin, consensusPlugin, openaiPlugin, sqlPlugin] },
  { character: betaCharacter, plugins: [consensusPlugin, openaiPlugin, sqlPlugin] },
  { character: gammaCharacter, plugins: [consensusPlugin, tradingExecutionPlugin, jupiterPlugin, openaiPlugin, sqlPlugin] }
]);
```

The trading-execution plugin calls `runtime.getService("JUPITER_SERVICE")`, which is only registered when `jupiterPlugin` is included in the character's plugin list. This was the root cause of the infinite loop bug during swarm startup (commit `d4701e5`).

## Installation

```bash
bun install
```

## Running the Swarm

Use the included management script:

```bash
./swarm.sh start    # Start all three agents
./swarm.sh status   # Check agent health
./swarm.sh stop     # Gracefully shutdown
./swarm.sh restart  # Restart the swarm
```

Or run manually:

```bash
bun run src/index.ts
```

## Configuration

Copy `.env.example` to `.env` and configure:

- `GAMMA_PRIVATE_KEY` — Gamma's Solana wallet (execution keypair)
- `SOLANA_RPC_URL` — Solana RPC endpoint
- `SLIPPAGE_BPS` — Jupiter slippage tolerance (default: 50 bps)
- `DRY_RUN=true` — Simulate trades without sending on-chain transactions
- OpenAI API keys for each agent

## Development

```bash
bun build    # Build optimized bundle
```

The build script externalizes ElizaOS and Solana dependencies for smaller bundle size.