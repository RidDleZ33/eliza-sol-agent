import { TrendingTokenWatcher } from "./TrendingTokenWatcher.ts";
import { TopTraderWatcher } from "./TopTraderWatcher.ts";
import { PhantomTrendingWatcher } from "./PhantomTrendingWatcher.ts";
import { DexScreenerLatestWatcher } from "./DexScreenerLatestWatcher.ts";
import { DexScreenerTrendingWatcher } from "./DexScreenerTrendingWatcher.ts";
import { BirdeyeNewListingWatcher } from "./BirdeyeNewListingWatcher.ts";
import { DexScreenerBoostsWatcher } from "./DexScreenerBoostsWatcher.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, ingestFlag, getDexscreenerTrendingPeriod } from "../../utils/env.ts";
import { logger } from "../LoggerService.ts";

export class IngestionManager {
  private watchers: Map<string, IngestionWatcher> = new Map();
  private intervalMs: number;

  constructor() {
    this.intervalMs = getIngestionInterval();

    // Gate each watcher on its ingestion flag (phase 6A + 6B + 7B)
    // Dex latest launches is dead (404); Birdeye new_listing is the new launch board.
    if (ingestFlag("INGEST_BIRDEYE_NEW_LISTING")) {
      this.registerWatcher(new BirdeyeNewListingWatcher());
    }
    // DexScreenerLatestWatcher still registered for legacy compat; will detect 404 and self-disable.
    if (ingestFlag("INGEST_DEXSCREENER_LATEST")) {
      this.registerWatcher(new DexScreenerLatestWatcher());
    }
    if (ingestFlag("INGEST_DEXSCREENER_TRENDING")) {
      this.registerWatcher(new DexScreenerTrendingWatcher());
    }
    if (ingestFlag("INGEST_BIRDEYE_TRENDING")) {
      this.registerWatcher(new TrendingTokenWatcher());
    }
    if (ingestFlag("INGEST_BIRDEYE_TOP_TRADERS")) {
      this.registerWatcher(new TopTraderWatcher());
    }
    if (ingestFlag("INGEST_PHANTOM")) {
      this.registerWatcher(new PhantomTrendingWatcher());
    }
    if (ingestFlag("INGEST_DEXSCREENER_BOOSTS")) {
      this.registerWatcher(new DexScreenerBoostsWatcher());
    }
  }

  public registerWatcher(watcher: IngestionWatcher): void {
    if (this.watchers.has(watcher.name)) {
      logger.warn("INGESTION", "IngestionManager", `Watcher '${watcher.name}' already registered. Overwriting.`);
    }
    this.watchers.set(watcher.name, watcher);
    logger.info("INGESTION", "IngestionManager", `Registered watcher: ${watcher.name}`);
  }

  start() {
    const enabledWatchers = Array.from(this.watchers.keys());
    logger.info("INGESTION", "IngestionManager", "Starting ingestion services", { enabledWatchers });
    logger.info("INGESTION", "IngestionManager", "Trending period", { period: getDexscreenerTrendingPeriod() });
    logger.info("INGESTION", "IngestionManager", "Polling base interval", { intervalMs: this.intervalMs });

    for (const watcher of this.watchers.values()) {
      try {
        watcher.start();
        logger.info("INGESTION", "IngestionManager", `Started watcher: ${watcher.name}`);
      } catch (e: any) {
        logger.error("INGESTION", "IngestionManager", `Failed to start watcher ${watcher.name}`, { error: e.message });
      }
    }

    logger.info("INGESTION", "IngestionManager", "All ingestion services started successfully");
  }

  stop() {
    logger.info("INGESTION", "IngestionManager", "Stopping all ingestion services...");

    for (const watcher of this.watchers.values()) {
      try {
        watcher.stop();
        logger.info("INGESTION", "IngestionManager", `Stopped watcher: ${watcher.name}`);
      } catch (e: any) {
        logger.error("INGESTION", "IngestionManager", `Error stopping watcher ${watcher.name}`, { error: e.message });
      }
    }

    logger.info("INGESTION", "IngestionManager", "All ingestion services stopped");
  }
}

export const ingestionManager = new IngestionManager();
export default ingestionManager;
