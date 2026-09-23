import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";

interface PhantomToken {
  address: string;
  symbol: string;
  volume24h: number;
}

export class PhantomTrendingWatcher implements IngestionWatcher {
  public name = "PhantomTrendingWatcher";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number = 1000;
  private maxBackoffMs: number = 60000;

  private primaryEndpoint = "https://api.phantom.app/user/v1/explore/solana/trending";
  private fallbackEndpoint = "https://explore-api.phantom.app/v1/trending/solana";

  start() {
    logger.info("INGESTION", "PhantomTrendingWatcher", "Starting Phantom trending token watcher");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    const intervalMs = configService.getNumber("INGESTION_INTERVAL_MS") || 120000;
    logger.debug("INGESTION", "PhantomTrendingWatcher", "Next poll scheduled", { intervalMs });
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("INGESTION", "PhantomTrendingWatcher", "Stopped");
  }

  private async poll() {
    try {
      logger.debug("INGESTION", "PhantomTrendingWatcher", "Polling Phantom for trending tokens...");
      let tokens: PhantomToken[] = await this.fetchFromPhantom();

      logger.info("INGESTION", "PhantomTrendingWatcher", "Found Phantom trending tokens", { count: tokens.length });

      let newDiscoveries = 0;
      let alreadyTracked = 0;

      for (const token of tokens) {
        const inserted = await watchlistService.addDiscoveredToken(
          token.address,
          token.symbol,
          token.volume24h
        );
        if (inserted) {
          newDiscoveries++;
        } else {
          alreadyTracked++;
        }
      }

      if (newDiscoveries > 0 || alreadyTracked > 0) {
        logger.info("INGESTION", "PhantomTrendingWatcher", "Phantom discovery complete", {
          total: tokens.length,
          newDiscoveries,
          alreadyTracked,
        });
      }

      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", "PhantomTrendingWatcher", "Error polling Phantom", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", "PhantomTrendingWatcher", "Backing off", { backoffMs: this.backoffMs });
    }
  }

  private async fetchFromPhantom(): Promise<PhantomToken[]> {
    const headers = {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/24.4.0",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://phantom.app",
      "Referer": "https://phantom.app/",
    };

    try {
      const res = await fetchWithRetry(this.primaryEndpoint, { headers });
      if (res.ok) {
        const data = await res.json();
        const rawTokens = data.tokens || data || [];
        return this.parseTokens(rawTokens);
      }
    } catch (e: any) {
      logger.warn("INGESTION", "PhantomTrendingWatcher", "Primary endpoint failed, trying fallback", { error: e.message });
    }

    // Fallback attempt
    const fallbackRes = await fetchWithRetry(this.fallbackEndpoint, { headers });
    if (!fallbackRes.ok) {
      throw new Error(`Phantom API fallback returned status ${fallbackRes.status}`);
    }

    const fallbackData = await fallbackRes.json();
    const rawTokens = fallbackData.data || fallbackData || [];
    return this.parseTokens(rawTokens);
  }

  private parseTokens(rawTokens: any[]): PhantomToken[] {
    const tokens: PhantomToken[] = [];
    for (const item of rawTokens) {
      const address = item.mintAddress || item.address || item.mint || item.id;
      const symbol = item.symbol || item.ticker || "UNKNOWN";
      const volume24h = parseFloat(item.volume24h || item.volume24hUsd || item.quote?.volume24h || "0");

      if (address && address.length >= 32) {
        tokens.push({
          address,
          symbol: symbol.toUpperCase(),
          volume24h,
        });
      }
    }
    return tokens;
  }
}
