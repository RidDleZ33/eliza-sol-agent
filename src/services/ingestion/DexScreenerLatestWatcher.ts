import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import {
  fetchDexJson,
  pairsFromUnknown,
  toDiscovered,
} from "./dexscreenerPairs.ts";
import {
  getDexscreenerChain,
  getMaxTrendingTokens,
} from "../../utils/env.ts";

export class DexScreenerLatestWatcher implements IngestionWatcher {
  public name = "dexscreener_latest";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private chainId: string;
  private endpointDead = false;

  constructor() {
    this.chainId = getDexscreenerChain();
  }

  private buildUrl(): string {
    return `https://api.dexscreener.com/tokens/latest/v1?chainId=${this.chainId}`;
  }

  start() {
    logger.info("INGESTION", this.name, "Starting");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) clearInterval(this.intervalId);
    const intervalMs = configService.getNumber("INGESTION_INTERVAL_MS");
    logger.debug("INGESTION", this.name, "Next poll scheduled", { intervalMs });
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("INGESTION", this.name, "Stopped");
  }

  private async poll() {
    if (this.endpointDead) {
      return;
    }

    try {
      logger.debug("INGESTION", this.name, "Polling");
      const url = this.buildUrl();
      let raw: unknown;
      try {
        raw = await fetchDexJson(url);
      } catch (e: any) {
        // If 404, try without query string
        if (e.message.includes("404")) {
          logger.warn("INGESTION", this.name, "404 with chainId query, trying without", { url });
          try {
            const fallbackUrl = "https://api.dexscreener.com/tokens/latest/v1";
            raw = await fetchDexJson(fallbackUrl);
          } catch (e2: any) {
            if (e2.message.includes("404")) {
              logger.warn("INGESTION", this.name, "Dex /tokens/latest/v1 is dead; launch board is Birdeye new_listing");
              this.endpointDead = true;
              return;
            }
            throw e2;
          }
        } else {
          throw e;
        }
      }

      const pairs = pairsFromUnknown(raw);
      const discovered: { address: string; symbol: string; volume24h: number }[] = [];

      for (const pair of pairs) {
        const tok = toDiscovered(pair, this.chainId);
        if (tok) {
          discovered.push({
            address: tok.address,
            symbol: tok.symbol,
            volume24h: tok.volume24h,
          });
        }
        if (discovered.length >= getMaxTrendingTokens()) break;
      }

      let newCount = 0;
      let dupCount = 0;
      for (let i = 0; i < discovered.length; i++) {
        const tok = discovered[i];
        const inserted = await watchlistService.addDiscoveredToken(
          tok.address,
          tok.symbol,
          tok.volume24h,
          "ds_latest"
        );
        if (inserted) {
          newCount++;
          // Phase 11A3N: stash pair at ingest so PA is warm on first Gamma tick
          const pair = pairs[i];
          if (pair && pair.priceUsd) {
            watchlistService.saveDexPair(tok.address, pair);
          }
        } else {
          dupCount++;
        }
      }

      logger.info("INGESTION", this.name, "Poll complete", {
        total: discovered.length,
        new: newCount,
        duplicates: dupCount,
      });
      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", this.name, "Backing off", { backoffMs: this.backoffMs });
    }
  }
}
