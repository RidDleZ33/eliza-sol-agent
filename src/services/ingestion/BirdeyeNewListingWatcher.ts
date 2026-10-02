import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey, getMaxTrendingTokens } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { requestAlphaTick } from "../../evaluators/AlphaNarrativeEvaluator.ts";

const SOURCE = "birdeye_new";

interface NewListingToken {
  address: string;
  symbol: string;
  volumeUSD: number;
}

export class BirdeyeNewListingWatcher implements IngestionWatcher {
  public name = "birdeye_new_listing";
  private birdeyeApiKey: string | undefined;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private noKeyLogged = false;
  private maxTokens: number;

  constructor() {
    this.birdeyeApiKey = getBirdeyeApiKey();
    this.maxTokens = getMaxTrendingTokens();
  }

  start() {
    logger.info("INGESTION", this.name, "Starting Birdeye new listing watcher");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
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
    try {
      if (!this.birdeyeApiKey) {
        if (!this.noKeyLogged) {
          logger.warn("INGESTION", this.name, "No Birdeye API key, will not poll new_listing");
          this.noKeyLogged = true;
        }
        this.backoffMs = 1000;
        return;
      }

      logger.debug("INGESTION", this.name, "Polling Birdeye new_listing...");
      const tokens = await this.fetchNewListing();

      logger.info("INGESTION", this.name, "New listing poll complete", {
        found: tokens.length,
        inserted: tokens.filter(t => t !== null).length,
      });
      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Error polling new_listing", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", this.name, "Backing off", { backoffMs: this.backoffMs });
    }
  }

  private async fetchNewListing(): Promise<(NewListingToken | null)[]> {
    const url = "https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&meme_platform_enabled=true";
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey!,
      "accept": "application/json",
    };

    logger.debug("INGESTION", this.name, "Fetching from Birdeye new_listing", { url });

    const response = await fetchWithRetry(url, { headers });

    if (!response.ok) {
      let body = "";
      try {
        body = (await response.text()).slice(0, 200);
      } catch {
        // ignore
      }
      throw new Error(`Birdeye HTTP ${response.status}: ${body}`);
    }

    const data = await response.json();

    if (data.success === false) {
      throw new Error(`Birdeye API error: ${data.message ?? data.msg ?? JSON.stringify(data).slice(0, 180)}`);
    }

    const items = data.data?.items || data.data?.tokens || [];
    logger.debug("INGESTION", this.name, "Birdeye new_listing returned items", { count: items.length });

    const results: (NewListingToken | null)[] = [];
    let insertCount = 0;
    for (const item of items) {
      if (results.length >= this.maxTokens) break;
      const address = item.address;
      const symbol = item.symbol || "UNKNOWN";
      const volumeUSD = item.volumeUSD ?? item.volume24hUSD ?? 0;

      if (!address || address.length < 32) {
        results.push(null);
        continue;
      }

      const inserted = await watchlistService.addDiscoveredToken(
        address,
        symbol,
        volumeUSD,
        SOURCE
      );

      if (inserted) {
        insertCount++;
        logger.info("INGESTION", this.name, "Discovered new token", {
          address,
          symbol,
          volumeUSD,
          source: SOURCE,
        });
      }

      results.push({ address, symbol, volumeUSD });
    }

    // Phase 8F: wake Alpha only on real inserts, not re-mapped rows
    if (insertCount > 0) {
      requestAlphaTick();
    }

    return results;
  }
}

export const birdeyeNewListingSource = {
  flag: "INGEST_BIRDEYE_NEW_LISTING",
  source: SOURCE,
  defaults: { INGEST_BIRDEYE_NEW_LISTING: "true" },
  create: () => new BirdeyeNewListingWatcher(),
};
