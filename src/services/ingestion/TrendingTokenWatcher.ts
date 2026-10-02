import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { requestAlphaTick } from "../../evaluators/AlphaNarrativeEvaluator.ts";

const SOURCE = "birdeye_trending";

interface TrendingToken {
  address: string;
  symbol: string;
  volume24h: number;
  liquidity?: number;
}

export class TrendingTokenWatcher implements IngestionWatcher {
  public name = "TrendingTokenWatcher";
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
      if (!this.birdeyeApiKey) {
        logger.warn("INGESTION", "TrendingTokenWatcher", "No Birdeye API key, skipping poll");
        this.backoffMs = 1000;
        return;
      }

      logger.debug("INGESTION", "TrendingTokenWatcher", "Polling for trending tokens...");
      logger.debug("INGESTION", "TrendingTokenWatcher", "Using Birdeye API");
      const tokens = await this.fetchFromBirdeye();

      logger.info("INGESTION", "TrendingTokenWatcher", "Found trending tokens", { count: tokens.length });

      let newDiscoveries = 0;
      let alreadyTracked = 0;

      for (const token of tokens) {
        logger.debug("INGESTION", "TrendingTokenWatcher", "Discovered token", {
          symbol: token.symbol,
          address: token.address,
          volume24h: token.volume24h,
        });
        const inserted = await watchlistService.addDiscoveredToken(
          token.address,
          token.symbol,
          token.volume24h,
          SOURCE
        );
        if (inserted) {
          newDiscoveries++;
        } else {
          alreadyTracked++;
        }
      }

      if (newDiscoveries > 0 || alreadyTracked > 0) {
        logger.info("INGESTION", "TrendingTokenWatcher", "Discovery complete", {
          total: tokens.length,
          newDiscoveries,
          alreadyTracked,
        });
      }

      if (newDiscoveries > 0) {
        requestAlphaTick();
      }

      this.backoffMs = 1000;
    } catch (e: any) {
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
      throw new Error(`Birdeye HTTP ${response.status}`);
    }

    const data = await response.json();

    // Handle both response formats:
    // Legacy: { code: 0, msg: "...", data: { items: [...] } }
    // Current live: { success: true, data: { tokens: [...] } }
    // Error format: { success: false, message: "..." }
    if (data.success === false) {
      throw new Error(`Birdeye API error: ${data.message ?? data.msg ?? JSON.stringify(data).slice(0, 180)}`);
    }

    // Try tokens first (current format), then items (legacy format)
    const items = data.data?.tokens || data.data?.items || [];
    logger.debug("INGESTION", "TrendingTokenWatcher", "Birdeye returned items", { count: items.length });

    return items.map((item: any) => ({
      address: item.address,
      symbol: item.symbol,
      volume24h: item.volume24hUSD ?? item.volume24h ?? 0,
      liquidity: item.liquidity,
    }));
  }

  // DexScreener token-profiles fallback retired in phase 6B.
  // Pair boards are handled by dedicated watchers.
}

export const birdeyeTrendingSource = {
  flag: "INGEST_BIRDEYE_TRENDING",
  source: SOURCE,
  defaults: { INGEST_BIRDEYE_TRENDING: "true" },
  create: () => new TrendingTokenWatcher(),
};
