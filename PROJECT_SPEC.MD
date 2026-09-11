# AI Committee: Three-Agent Solana Trading Swarm

A three-agent autonomous trading committee built on ElizaOS. Each agent specializes in one aspect of the Solana trading ecosystem and collaborates in a shared "war room" to identify, evaluate, and execute trades.

## Architecture

The swarm consists of three specialized agents with a clear separation of concerns:

### Alpha - Momentum Hunter
- **Role:** Scans social velocity and narrative momentum
- **Specialization:** Identifies early organic interest, influencer calls, and emerging metas before DEX trending lists update
- **Output:** Structured narrative evaluations with ticker, mint address, reasoning, and confidence score (0.0-1.0)
- **Constraints:** Does NOT trade directly; provides only signal data

### Beta - Quant Analyst
- **Role:** On-chain forensics and risk analysis
- **Specialization:** Liquidity pool depth, top holder distributions, mint authority status, pool burn ratios
- **Output:** Contract security assessments (PASS/FAIL), technical verification parameters
- **Constraints:** Does NOT trade; evaluates tokens strictly on hard on-chain telemetry

### Gamma - Risk Officer & Executor
- **Role:** Chief Risk Officer and sole execution agent
- **Specialization:** Portfolio exposure guardrails, consensus evaluation, trade execution
- **Output:** Approval/rejection decisions, Jito-bundled Jupiter swaps
- **Constraints:** ONLY agent with trade execution interface; cannot alter position sizing via text

## Consensus Protocol

Trades execute only when ALL conditions are met:
1. **Alpha signals:** Narrative Confidence Score ≥ 0.75
2. **Beta verifies:** Contract security PASS (liquidity locked, top 10 ≤ 25%, mint disabled)
3. **Gamma approves:** Portfolio limits allow entry

## Technology Stack

- **Framework:** ElizaOS v1.6.0 (`@elizaos/core`)
- **Database:** `@elizaos/plugin-sql` with dynamic runtime migrations
- **LLM Backend:** Ollama (`openai` compatible endpoint at `/v1`)
- **Model:** `qwen2.5:3b` (configurable via `MODEL_NAME` env var)
- **Web UI:** `@elizaos/ui` served on port 8007
- **Solana Plugins:** `@elizaos/plugin-solana`, `@elizaos/plugin-jupiter`

## Project Structure

```
eliza-sol-agent/
├── src/
│   └── index.ts              # Main entry point
├── plugins/
│   ├── consensus/            # Shared consensus room
│   └── trading-execution/    # Gamma's trade execution actions
├── utils/
│   └── env.ts                # Typed environment config
├── characters/
│   ├── alpha.json            # Momentum Hunter config
│   ├── beta.json             # Quant Analyst config
│   └── gamma.json            # Risk Officer config
├── .env                      # Environment variables
├── package.json
└── tsconfig.json
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OLLAMA_BASE_URL` | Ollama API endpoint (with `/v1`) | `http://arceus:11434/v1` |
| `OLLAMA_API_KEY` | API key (can be dummy) | `ollama` |
| `MODEL_NAME` | Ollama model name | `qwen2.5:3b` |
| `ELIZAOS_WEB_PORT` | Web UI port | `8007` |
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `SOLANA_PUBLIC_KEY` | Trading wallet public key | `<your-pubkey>` |
| `JITO_BUNDLE_URL` | Jito MEV bundle endpoint | `https://mainnet.block-engine.jito.wtf/api/v1/bundles` |

## Running the Swarm

```bash
# Install dependencies
bun install

# Start the swarm
bun run src/index.ts
```

The web UI will be available at `http://localhost:8007`.

## Key Design Decisions

1. **Separation of Concerns:** Each agent has one clear responsibility; no overlap.
2. **Consensus Over Speed:** Two approvals required before execution.
3. **Hardcoded Limits:** Trade limits set in environment, not via LLM text.
4. **Jito Bundles:** MEV protection for all executed trades.
5. **Signal Data:** Alpha and Beta provide structured data, not prose.

## Future Enhancements

- Add `@elizaos/plugin-telegram` for alerts
- Integrate DexScreener and Birdeye API providers
- Add automated dry-run backtesting mode
- Implement dynamic position sizing based on volatility