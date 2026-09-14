import { TrendingTokenWatcher } from "./TrendingTokenWatcher.ts";
import { TopTraderWatcher } from "./TopTraderWatcher.ts";
import { getIngestionInterval } from "../../utils/env.ts";
import { logger } from "../LoggerService.ts";

export class IngestionManager {
  private trendingWatcher: TrendingTokenWatcher;
  private traderWatcher: TopTraderWatcher;
  private intervalMs: number;

  constructor() {
    this.intervalMs = getIngestionInterval();
    this.trendingWatcher = new TrendingTokenWatcher(this.intervalMs);
    this.traderWatcher = new TopTraderWatcher(this.intervalMs);
  }

  start() {
    logger.info("INGESTION", "IngestionManager", "Starting ingestion services...");
    logger.info("INGESTION", "IngestionManager", "Polling interval", { intervalMs: this.intervalMs });

    this.trendingWatcher.start();
    this.traderWatcher.start();

    logger.info("INGESTION", "IngestionManager", "All ingestion services started");
  }

  stop() {
    logger.info("INGESTION", "IngestionManager", "Stopping ingestion services...");

    this.trendingWatcher.stop();
    this.traderWatcher.stop();

    logger.info("INGESTION", "IngestionManager", "All ingestion services stopped");
  }
}

export const ingestionManager = new IngestionManager();
export default ingestionManager;