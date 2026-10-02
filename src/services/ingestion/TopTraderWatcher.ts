import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";

interface TopTrader {
  walletAddress: string;
  label: string;
  realizedPnl: number;
  tradesBuy: number;
  tradesSell: number;
}

export class TopTraderWatcher implements IngestionWatcher {
  public name = "TopTraderWatcher";
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

      // Top traders endpoint requires specific mint addresses.
      // Without them, there's no global whale list to fetch.
      const mints = this.getMintAddresses();
      if (mints.length === 0) {
        logger.debug("INGESTION", "TopTraderWatcher", "No mint addresses configured, skipping");
        return;
      }

      logger.debug("INGESTION", "TopTraderWatcher", "Using Birdeye API for mints", { count: mints.length });

      // For now, aggregate traders across the configured mints.
      // In future phases, this could spawn per-mint watchers.
      let traders: TopTrader[] = [];
      for (const mint of mints) {
        const mintTraders = await this.fetchFromBirdeye(mint);
        traders = traders.concat(mintTraders);
      }

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

      // In production, this would also monitor trader wallets for new buys
      // and call watchlistService.addDiscoveredToken() on those mints

      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", "TopTraderWatcher", "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", "TopTraderWatcher", "Backing off", { backoffMs: this.backoffMs });
    }
  }

  private getMintAddresses(): string[] {
    const mintsEnv = process.env.BIRDEYE_TOP_TRADER_MINTS;
    if (!mintsEnv) return [];
    return mintsEnv
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }

  private async fetchFromBirdeye(address: string): Promise<TopTrader[]> {
    const url = `https://public-api.birdeye.so/defi/v2/tokens/top_traders?time_frame=24h&sort_by=realized_pnl&sort_type=desc&limit=15&address=${address}`;
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey!,
      accept: "application/json",
    };

    logger.debug("INGESTION", "TopTraderWatcher", "Fetching top traders from Birdeye", { url });

    const response = await fetchWithRetry(url, { headers });

    if (response.status === 429) {
      throw new Error("Birdeye rate limited");
    }

    if (!response.ok) {
      throw new Error(`Birdeye HTTP ${response.status}`);
    }

    const data = await response.json();

    // Handle both response formats (legacy code/msg vs current success/message)
    if (data.success === false) {
      throw new Error(`Birdeye API error: ${data.message ?? data.msg ?? JSON.stringify(data).slice(0, 180)}`);
    }

    const items = data.data?.items || data.data?.traders || [];
    logger.debug("INGESTION", "TopTraderWatcher", "Birdeye returned traders", { count: items.length, address });

    return items.map((item: any) => ({
      walletAddress: item.address ?? item.walletAddress,
      label: item.label,
      realizedPnl: item.realized_pnl ?? item.realizedPnl ?? 0,
      tradesBuy: item.trades_buy ?? item.tradesBuy ?? 0,
      tradesSell: item.trades_sell ?? item.tradesSell ?? 0,
    }));
  }
}

export const birdeyeTopTradersSource = {
  flag: "INGEST_BIRDEYE_TOP_TRADERS",
  source: "birdeye_top_traders",
  defaults: { INGEST_BIRDEYE_TOP_TRADERS: "false" },
  create: () => new TopTraderWatcher(),
};
