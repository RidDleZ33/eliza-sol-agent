import { Plugin } from "@elizaos/core";
import { watchlistService } from "../../services/WatchlistService.ts";

export const watchlistPlugin: Plugin = {
  name: "watchlist",
  description: "AI Committee dynamic watchlist management for trending tokens and top traders",

  actions: [
    {
      name: "ADD_WATCHED_TOKEN",
      description: "Add a token to the trending watchlist with narrative score and volume",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address" },
          symbol: { type: "string", description: "Token symbol" },
          narrative_score: { type: "number", description: "Narrative strength 0-1" },
          volume_24h: { type: "number", description: "24h trading volume" },
          agent: { type: "string", description: "Agent adding the token" }
        },
        required: ["mint", "symbol", "narrative_score"]
      },
      examples: [
        {
          user: "Add PEPE token with high narrative score",
          assistant: "Added PEPE to trending watchlist with narrative score 0.85"
        }
      ],
      handler: async (runtime, message) => {
        try {
          const params = JSON.parse(message.content);
          const success = await watchlistService.addToken({
            mint_address: params.mint,
            symbol: params.symbol,
            narrative_score: parseFloat(params.narrative_score),
            volume_24h: parseFloat(params.volume_24h) || 0,
            added_by_agent: params.agent || "Alpha"
          });
          if (success) {
            runtime.logger.info(`Token added to watchlist: ${params.symbol} (${params.mint})`);
            return `Added ${params.symbol} (${params.mint}) to trending watchlist`;
          }
          return `Failed to add ${params.symbol} to watchlist`;
        } catch (e) {
          runtime.logger.error(`Error adding token: ${e.message}`);
          return `Error adding token: ${e.message}`;
        }
      }
    },
    {
      name: "PRUNE_WATCHED_TOKEN",
      description: "Remove a token from the trending watchlist",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string", description: "Token mint address to remove" }
        },
        required: ["mint"]
      },
      examples: [
        {
          user: "Remove outdated token from watchlist",
          assistant: "Removed token from trending watchlist"
        }
      ],
      handler: async (runtime, message) => {
        try {
          const params = JSON.parse(message.content);
          await watchlistService.removeToken(params.mint);
          runtime.logger.info(`Token removed from watchlist: ${params.mint}`);
          return `Removed ${params.mint} from trending watchlist`;
        } catch (e) {
          runtime.logger.error(`Error removing token: ${e.message}`);
          return `Error removing token: ${e.message}`;
        }
      }
    },
    {
      name: "LIST_WATCHED_TOKENS",
      description: "Get all currently watched tokens with their scores",
      parameters: {
        type: "object",
        properties: {}
      },
      examples: [
        {
          user: "Show me the current trending token watchlist",
          assistant: "Current watchlist: PEPE (0.85), WIF (0.72), BONK (0.65)"
        }
      ],
      handler: async (runtime, message) => {
        try {
          const tokens = await watchlistService.getWatchedTokens();
          if (tokens.length === 0) {
            return "Trending token watchlist is empty";
          }
          const summary = tokens
            .map((t) => `${t.symbol} (${t.narrative_score})`)
            .join(", ");
          return `Current watchlist (${tokens.length}): ${summary}`;
        } catch (e) {
          runtime.logger.error(`Error listing tokens: ${e.message}`);
          return `Error listing tokens: ${e.message}`;
        }
      }
    },
    {
      name: "ADD_WATCHED_TRADER",
      description: "Add a top trader to the watched traders list",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Trader wallet address" },
          label: { type: "string", description: "Trader label/identifier" },
          win_rate_7d: { type: "number", description: "7-day win rate 0-1" },
          pnl_7d_usd: { type: "number", description: "7-day PnL in USD" },
          agent: { type: "string", description: "Agent adding the trader" }
        },
        required: ["wallet", "label", "win_rate_7d"]
      },
      examples: [
        {
          user: "Track this profitable trader wallet",
          assistant: "Added trader to watched list"
        }
      ],
      handler: async (runtime, message) => {
        try {
          const params = JSON.parse(message.content);
          const success = await watchlistService.addTrader({
            wallet_address: params.wallet,
            label: params.label,
            win_rate_7d: parseFloat(params.win_rate_7d),
            pnl_7d_usd: parseFloat(params.pnl_7d_usd) || 0,
            added_by_agent: params.agent || "Beta"
          });
          if (success) {
            runtime.logger.info(`Trader added to watchlist: ${params.label} (${params.wallet})`);
            return `Added trader ${params.label} (${params.wallet}) to watched traders`;
          }
          return `Failed to add trader ${params.label} to watchlist`;
        } catch (e) {
          runtime.logger.error(`Error adding trader: ${e.message}`);
          return `Error adding trader: ${e.message}`;
        }
      }
    },
    {
      name: "PRUNE_WATCHED_TRADER",
      description: "Remove a trader from the watched traders list",
      parameters: {
        type: "object",
        properties: {
          wallet: { type: "string", description: "Trader wallet address to remove" }
        },
        required: ["wallet"]
      },
      examples: [
        {
          user: "Stop tracking this underperforming trader",
          assistant: "Removed trader from watched list"
        }
      ],
      handler: async (runtime, message) => {
        try {
          const params = JSON.parse(message.content);
          await watchlistService.removeTrader(params.wallet);
          runtime.logger.info(`Trader removed from watchlist: ${params.wallet}`);
          return `Removed trader ${params.wallet} from watched traders`;
        } catch (e) {
          runtime.logger.error(`Error removing trader: ${e.message}`);
          return `Error removing trader: ${e.message}`;
        }
      }
    },
    {
      name: "LIST_WATCHED_TRADERS",
      description: "Get all currently watched traders with their performance",
      parameters: {
        type: "object",
        properties: {}
      },
      examples: [
        {
          user: "Show me the traders we're watching",
          assistant: "Watching 5 traders: PhantomTopTrader (85%), WhaleKing (78%), ..."
        }
      ],
      handler: async (runtime, message) => {
        try {
          const traders = await watchlistService.getWatchedTraders();
          if (traders.length === 0) {
            return "Watched traders list is empty";
          }
          const summary = traders
            .map((t) => `${t.label} (${t.win_rate_7d * 100}%)`)
            .join(", ");
          return `Watching ${traders.length} traders: ${summary}`;
        } catch (e) {
          runtime.logger.error(`Error listing traders: ${e.message}`);
          return `Error listing traders: ${e.message}`;
        }
      }
    }
  ]
};