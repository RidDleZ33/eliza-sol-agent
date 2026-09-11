Module 1: AI-Managed Dynamic Watchlist (State Engine)
​Instead of static arrays, create a database service where Alpha and Beta dynamically maintain and mutate watchlists based on configurable caps.
​Config Limits: Define environment variables MAX_TRENDING_TOKENS (e.g., 10) and MAX_TOP_TRADERS (e.g., 15).
​Database Tables: Create two tables in SQLite/PostgreSQL: watched_tokens and watched_traders.
​Dynamic Mutation Logic:
​Alpha can call add_token() or prune_token() to replace cold narrative tokens with higher-velocity ones.
​Beta can call add_trader() or prune_trader() based on rolling 7-day win rate and PnL metrics.

Module 2: Discovery & Ingestion Services
​Build two background worker threads that populate the database tables from Module 1.
​Trending Token Watcher: Polls Birdeye (/defi/token_trending) or DexScreener API every 60 seconds. Passes top candidate mint addresses to Alpha for narrative scoring.
​Top Trader Discovery Service: Queries Birdeye's Top Traders API (/defi/v2/tokens/top_traders) or wallet leaderboards. Extracts wallets with high realized PnL and win rates (>65%), passing them to Beta to update watched_traders.

Module 3: Alpha Agent — Social & Narrative Evaluator
​Alpha analyzes unstructured social sentiment for tokens added to watched_tokens.
Social Scraping: Hooks into Twitter/X search API or Telegram channel scrapers for token tickers and mint addresses.
Sentiment Synthesis: Runs Qwen 3.8 27B to evaluate post volume, engagement quality (organic vs. bot activity), and influencer sentiment.
War Room Output: Writes structured JSON into the shared DB room:
{
  "event": "NARRATIVE_EVALUATION",
  "token_mint": "...",
  "narrative_score": 0.82,
  "organic_volume_trend": "SURGING"
}


Module 4: Beta Agent — Wallet Mirroring & Contract Forensics
​Beta handles two jobs: watching target wallets and verifying contract safety.
Wallet Mirror Listener: Subscribes watched_traders addresses to a Helius Webhook (or RPC WebSocket). Whenever a top trader executes a buy transaction, Beta intercepts the mint address immediately.
Contract Forensics Engine: Beta queries on-chain data for the target token to inspect:
​Liquidity pool lock/burn status.
​Top 10 holder distribution (fails if top non-LP wallets hold >25%).
​Mint authority and freeze authority (must be disabled).
War Room Output: Writes the technical evaluation to the shared DB room:
{
  "event": "CONTRACT_SAFETY_CHECK",
  "token_mint": "...",
  "trader_wallet": "...",
  "security_status": "PASS",
  "liquidity_usd": 125000
}

Module 5: Gamma Agent — Consensus & Execution Engine
​Gamma evaluates the shared DB war room logs and executes trades securely.
​Consensus Evaluator: Triggers when a token has matched records from both Alpha and Beta within a short time window (e.g., <3 minutes).
​Hard Guardrail Verification: Reads process.env.MAX_TRADE_SIZE_SOL directly from code (bypassing LLM prompt decision-making).
​Trade Execution: Triggers @elizaos/plugin-jupiter wrapped in a Jito bundle (jito-ts) to submit private transactions directly to Solana validators, avoiding public RPC sandwich bots.
​Telegram Notification: Emits a final alert via your Telegram telemetry plugin showing entry price, token mint, and the trader wallet mirrored.
