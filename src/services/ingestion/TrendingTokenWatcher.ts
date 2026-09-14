import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";

interface TrendingToken {
  address: string;
  symbol: string;
  volume24h: number;
  liquidity?: number;
}

export class TrendingTokenWatcher {
  private birdeyeApiKey: string | undefined;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number = 1000;
  private maxBackoffMs: number = 60000;

  constructor() {
    this.birdeyeApiKey = getBirdeyeApiKey();
  }

  start() {
    logger.info("INGESTION", "TrendingTokenWatcher", "Starting trending token watcher");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    const intervalMs = configService.getNumber("INGESTION_INTERVAL_MS");
    logger.debug("INGESTION", "TrendingTokenWatcher", "Next poll scheduled", { intervalMs });
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("INGESTION", "TrendingTokenWatcher", "Stopped");
  }

  private async poll() {
    try {
      logger.debug("INGESTION", "TrendingTokenWatcher", "Polling for trending tokens...");
      let tokens: TrendingToken[] = [];

      if (this.birdeyeApiKey) {
        logger.debug("INGESTION", "TrendingTokenWatcher", "Using Birdeye API");
        tokens = await this.fetchFromBirdeye();
      }

      if (!tokens || tokens.length === 0) {
        logger.debug("INGESTION", "TrendingTokenWatcher", "Birdeye empty, trying DexScreener fallback");
        tokens = await this.fetchFromDexScreener();
      }

      logger.info("INGESTION", "TrendingTokenWatcher", "Found trending tokens", { count: tokens.length });

      for (const token of tokens) {
        logger.debug("INGESTION", "TrendingTokenWatcher", "Adding token to watchlist", {
          symbol: token.symbol,
          address: token.address,
          volume24h: token.volume24h,
        });
        await watchlistService.addToken({
          mint_address: token.address,
          symbol: token.symbol,
          narrative_score: 0.5,
          volume_24h: token.volume24h,
          added_by_agent: "system",
        });
      }

      this.backoffMs = 1000;
    } catch (e) {
      logger.error("INGESTION", "TrendingTokenWatcher", "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", "TrendingTokenWatcher", "Backing off", { backoffMs: this.backoffMs });
    }
  }

  private async fetchFromBirdeye(): Promise<TrendingToken[]> {
    const url = "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10";
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey!,
      "accept": "application/json",
    };

    logger.debug("INGESTION", "TrendingTokenWatcher", "Fetching from Birdeye", { url });

    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      throw new Error(`Birdeye API returned ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 0 && data.data?.items === undefined) {
      throw new Error(`Birdeye API error: ${data.msg}`);
    }

    const items = data.data?.items || [];
    logger.debug("INGESTION", "TrendingTokenWatcher", "Birdeye returned items", { count: items.length });

    return items.map((item: any) => ({
      address: item.address,
      symbol: item.symbol,
      volume24h: item.volume24h || 0,
      liquidity: item.liquidity,
    }));
  }

  private async fetchFromDexScreener(): Promise<TrendingToken[]> {
    const url = "https://api.dexscreener.com/token-profiles/latest/v1?limit=50";

    logger.debug("INGESTION", "TrendingTokenWatcher", "Fetching from DexScreener", { url });

    const response = await fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`DexScreener API returned ${response.status}`);
    }

    const profiles: any[] = await response.json();
    logger.debug("INGESTION", "TrendingTokenWatcher", "DexScreener returned profiles", { count: profiles.length });

    const solProfiles = profiles.filter((p: any) => p.chainId === "solana");
    logger.debug("INGESTION", "TrendingTokenWatcher", "Solana profiles filtered", { count: solProfiles.length });

    if (solProfiles.length === 0) {
      logger.info("INGESTION", "TrendingTokenWatcher", "No Solana tokens in trending");
      return [];
    }

    const tokens: TrendingToken[] = [];
    for (const profile of solProfiles.slice(0, 10)) {
      try {
        logger.debug("INGESTION", "TrendingTokenWatcher", "Fetching pair data", { address: profile.tokenAddress });
        const pairData = await this.fetchSolanaPairData(profile.tokenAddress);
        if (pairData) {
          tokens.push(pairData);
        }
      } catch (e) {
        logger.warn("INGESTION", "TrendingTokenWatcher", "Failed to fetch pair data", {
          address: profile.tokenAddress,
          error: e.message,
        });
      }
    }

    logger.debug("INGESTION", "TrendingTokenWatcher", "Successfully fetched pair data", { count: tokens.length });
    return tokens;
  }

  private async fetchSolanaPairData(tokenAddress: string): Promise<TrendingToken | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

    const response = await fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`DexScreener pair API returned ${response.status}`);
    }

    const data = await response.json();

    const solPairs = (data.pairs || []).filter((pair: any) => pair.chainId === "solana");
    if (solPairs.length === 0) {
      return null;
    }

    const bestPair = solPairs[0];

    return {
      address: bestPair.baseToken.address,
      symbol: bestPair.baseToken.symbol,
      volume24h: bestPair.volume?.h24?.usd || 0,
      liquidity: bestPair.liquidity?.usd || 0,
    };
  }
}
