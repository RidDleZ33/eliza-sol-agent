import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, getDexscreenerTrendingPeriod, isTruthyFlag } from "../../utils/env.ts";
import { logger } from "../LoggerService.ts";
import { birdeyeNewListingSource } from "./BirdeyeNewListingWatcher.ts";
import { dexScreenerLatestSource } from "./DexScreenerLatestWatcher.ts";
import { dexScreenerTrendingSource } from "./DexScreenerTrendingWatcher.ts";
import { birdeyeTrendingSource } from "./TrendingTokenWatcher.ts";
import { birdeyeTopTradersSource } from "./TopTraderWatcher.ts";
import { phantomTrendingSource } from "./PhantomTrendingWatcher.ts";
import { dexScreenerBoostsSource } from "./DexScreenerBoostsWatcher.ts";

// Phase 12A: ingestion source registry.
// Each watcher file exports a spec; this list is the single place that
// enables a feed. Adding a new feed = one watcher file + one spec export
// + one line here + one .env.example row.
const SOURCE_REGISTRY = [
  birdeyeNewListingSource,
  dexScreenerLatestSource,
  dexScreenerTrendingSource,
  birdeyeTrendingSource,
  birdeyeTopTradersSource,
  phantomTrendingSource,
  dexScreenerBoostsSource,
];

export class IngestionManager {
  private watchers: Map<string, IngestionWatcher> = new Map();
  private intervalMs: number;

  constructor() {
    this.intervalMs = getIngestionInterval();

    for (const spec of SOURCE_REGISTRY) {
      const enabled = isTruthyFlag(process.env[spec.flag] ?? spec.defaults[spec.flag]);
      logger.info("INGESTION", "IngestionManager", `${spec.flag}=${enabled} for ${spec.source}`);
      if (enabled) {
        this.registerWatcher(spec.create());
      }
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
