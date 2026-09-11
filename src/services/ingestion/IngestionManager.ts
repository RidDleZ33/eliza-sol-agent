import { TrendingTokenWatcher } from "./TrendingTokenWatcher.ts";
import { TopTraderWatcher } from "./TopTraderWatcher.ts";
import { getIngestionInterval } from "../../utils/env.ts";

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
    console.log("[IngestionManager] Starting ingestion services...");
    console.log(`[IngestionManager] Polling interval: ${this.intervalMs}ms`);

    this.trendingWatcher.start();
    this.traderWatcher.start();

    console.log("[IngestionManager] All ingestion services started");
  }

  stop() {
    console.log("[IngestionManager] Stopping ingestion services...");

    this.trendingWatcher.stop();
    this.traderWatcher.stop();

    console.log("[IngestionManager] All ingestion services stopped");
  }
}

export const ingestionManager = new IngestionManager();
export default ingestionManager;