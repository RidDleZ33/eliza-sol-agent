# Project Specification: ElizaOS Autonomous Solana Trading Swarm (The AI Committee)

You are an expert TypeScript developer and systems architect. We are building an autonomous, multi-agent algorithmic trading committee on Solana using the ElizaOS framework. 

Your objective is to write clean, modular, and typed code agentically based on the architecture, deep reasoning, and guardrails detailed below.

---

## 1. Deep Reasoning & Core Philosophy

1. **The LLM Is Not A HFT Bot:** LLMs cannot compete on raw latency or execution speed. The LLM's edge lies purely in **Natural Language Processing (NLP), unstructured data synthesis (social arbitrage), and holistic risk evaluation**.
2. **Separation of Concerns:** High-frequency on-chain data analysis and data fetching must be handled by standard APIs/code. The LLMs reason over the *outputs* of these scripts.
3. **The Multi-Agent Committee:** Never trust a single prompt to manage a wallet. We use a three-agent consensus loop to filter noise, prevent reckless behavior, and validate trades before a single lampost of SOL is spent.

---

## 2. Agent Architecture & Roles

We are spinning up three distinct ElizaOS instances, each running a unique `character.json` configuration. They communicate through a shared local database room (or private Discord/Telegram channel) acting as their "War Room."

### ┌── Agent 1: Alpha (The Hunter)
*   **Focus:** Momentum and social velocity.
*   **Mechanics:** Uses ElizaOS Twitter/Telegram scraping plugins to track trending tickers, alpha callers, and keyword frequency spikes.
*   **Output:** Logs highly qualitative narrative scores to the shared Room.

### ├── Agent 2: Beta (The Quant)
*   **Focus:** On-chain metrics and rug prevention.
*   **Mechanics:** Hooks into `@elizaos/plugin-solana` (DexScreener/Birdeye/Helius). When Alpha flags a token, Beta scans its contract: liquidity lock status, top 10 holder distribution, and pool depth.
*   **Output:** Logs raw technical validation data and security statuses to the shared Room.

### └── Agent 3: Gamma (The Risk Officer)
*   **Focus:** Capital preservation, consensus evaluation, and execution.
*   **Mechanics:** **Only Gamma possesses the private key and access to `@elizaos/plugin-jupiter`.** It reads the Room state, runs an internal Evaluator to ensure both Alpha and Beta have signed off on a mint address, and checks internal portfolio limits.
*   **Output:** Triggers the Jupiter swap transaction.

---

## 3. Communication & Consensus Flow

1. **Signal Ingestion:** Alpha or Beta flags an asset.
2. **State Sync:** Both agents write their structured data into the shared Room history.
3. **Evaluation:** Gamma’s runtime loop triggers an `Evaluator`. It parses the message history into a strict JSON schema:
   ```json
   {
     "token_mint": "string",
     "narrative_momentum": "boolean",
     "liquidity_verified": "boolean",
     "risk_score_acceptable": "boolean"
   }
   ```
4. **Execution:** If all criteria are `true`, Gamma triggers its custom execution action.

---

## 4. Hard Coding Guardrails & Security

*   **Zero LLM Budgeting:** The LLM must *never* determine the token amount or SOL size within its prompt text. 
*   **Code-Level Hardcoding:** Position sizing must be loaded from strict environment variables (e.g., `process.env.MAX_TRADE_SIZE_SOL`) inside the TypeScript execution file, completely insulated from LLM outputs to prevent hallucinated drain events.
*   **MEV Protection:** All swaps executed via `@elizaos/plugin-jupiter` must be packaged using Jito bundles (`jito-ts`) to avoid sandwich attacks and front-running on public RPC nodes.

---

## 5. Development Instructions for the Agent

*   Use **TypeScript** exclusively with explicit type definitions.
*   Keep ElizaOS `Actions`, `Evaluators`, and `Providers` isolated and modular.
*   Ensure all interaction with the Solana blockchain gracefully handles transaction failures and timeouts.
*   When creating or modifying characters, ensure their `system` prompts explicitly restrict them to their specific analytical domains.

Do not write boilerplate or monolithic files. Build incrementally, testing the interfaces between the shared memory state before writing the execution blocks.
