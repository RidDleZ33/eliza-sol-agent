import { TrendingTokenWatcher } from "./TrendingTokenWatcher.ts";
import { TopTraderWatcher } from "./TopTraderWatcher.ts";
import { PhantomTrendingWatcher } from "./PhantomTrendingWatcher.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval } from "../../utils/env.ts";
import { logger } from "../LoggerService.ts";

export class IngestionManager {
  private watchers: Map<string, IngestionWatcher> = new Map();
  private intervalMs: number;

  constructor() {
    this.intervalMs = getIngestionInterval();

    // Register built-in default watchers
    this.registerWatcher(new TrendingTokenWatcher());
    this.registerWatcher(new TopTraderWatcher());
    this.registerWatcher(new PhantomTrendingWatcher());
  }

  public registerWatcher(watcher: IngestionWatcher): void {
    if (this.watchers.has(watcher.name)) {
      logger.warn("INGESTION", "IngestionManager", `Watcher '${watcher.name}' already registered. Overwriting.`);
    }
    this.watchers.set(watcher.name, watcher);
    logger.info("INGESTION", "IngestionManager", `Registered watcher: ${watcher.name}`);
  }

  start() {
    logger.info("INGESTION", "IngestionManager", "Starting all ingestion services...");
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
