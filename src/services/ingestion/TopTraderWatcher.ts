import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";

interface TopTrader {
  walletAddress: string;
  label: string;
  realizedPnl: number;
  tradesBuy: number;
  tradesSell: number;
}

export class TopTraderWatcher {
  private birdeyeApiKey: string | undefined;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs: number = 1000;
  private maxBackoffMs: number = 60000;

  constructor() {
    this.birdeyeApiKey = getBirdeyeApiKey();
  }

  start() {
    logger.info("INGESTION", "TopTraderWatcher", "Starting top trader watcher");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    const intervalMs = configService.getNumber("INGESTION_INTERVAL_MS");
    logger.debug("INGESTION", "TopTraderWatcher", "Next poll scheduled", { intervalMs });
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info("INGESTION", "TopTraderWatcher", "Stopped");
  }

  private async poll() {
    try {
      logger.debug("INGESTION", "TopTraderWatcher", "Polling for top traders...");

      if (!this.birdeyeApiKey) {
        logger.debug("INGESTION", "TopTraderWatcher", "No Birdeye API key, skipping");
        return;
      }

      logger.debug("INGESTION", "TopTraderWatcher", "Using Birdeye API");
      let traders: TopTrader[] = await this.fetchFromBirdeye();

      traders = traders.filter((t) => t.realizedPnl > 1000 && t.tradesBuy > 2);

      logger.info("INGESTION", "TopTraderWatcher", "Found top traders after filtering", { count: traders.length });

      for (const trader of traders) {
        const winRate =
          trader.tradesBuy + trader.tradesSell > 0
            ? trader.tradesBuy / (trader.tradesBuy + trader.tradesSell)
            : 0;

        logger.debug("INGESTION", "TopTraderWatcher", "Adding trader to watchlist", {
          wallet: trader.walletAddress,
          winRate,
          realizedPnl: trader.realizedPnl,
        });

        await watchlistService.addTrader({
          wallet_address: trader.walletAddress,
          label: trader.label || `trader_${trader.walletAddress.slice(0, 8)}`,
          win_rate_7d: winRate,
          pnl_7d_usd: trader.realizedPnl,
          added_by_agent: "system",
        });
      }

      this.backoffMs = 1000;
    } catch (e) {
      logger.error("INGESTION", "TopTraderWatcher", "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", "TopTraderWatcher", "Backing off", { backoffMs: this.backoffMs });
    }
  }

  private async fetchFromBirdeye(): Promise<TopTrader[]> {
    const url =
      "https://public-api.birdeye.so/defi/v2/tokens/top_traders?time_frame=24h&sort_by=realizedPnl&sort_type=desc&limit=15";
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey!,
      accept: "application/json",
    };

    logger.debug("INGESTION", "TopTraderWatcher", "Fetching from Birdeye", { url });

    const response = await fetch(url, { headers });

    if (response.status === 429) {
      throw new Error("Rate limited by Birdeye API");
    }

    if (!response.ok) {
      throw new Error(`Birdeye API returned ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 0 && data.data?.items === undefined) {
      throw new Error(`Birdeye API error: ${data.msg}`);
    }

    const items = data.data?.items || [];
    logger.debug("INGESTION", "TopTraderWatcher", "Birdeye returned traders", { count: items.length });

    return items.map((item: any) => ({
      walletAddress: item.walletAddress,
      label: item.label,
      realizedPnl: item.realizedPnl || 0,
      tradesBuy: item.tradesBuy || 0,
      tradesSell: item.tradesSell || 0,
    }));
  }
}
