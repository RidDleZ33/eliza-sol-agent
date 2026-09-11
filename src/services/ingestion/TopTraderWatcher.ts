import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";

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
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    const intervalMs = configService.getNumber("INGESTION_INTERVAL_MS");
    console.log(`[TopTraderWatcher] Next poll in ${intervalMs}ms`);
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log("[TopTraderWatcher] Stopped");
  }

  private async poll() {
    try {
      console.log("[TopTraderWatcher] Polling for top traders...");

      if (!this.birdeyeApiKey) {
        console.log("[TopTraderWatcher] No Birdeye API key, skipping");
        return;
      }

      let traders: TopTrader[] = await this.fetchFromBirdeye();

      // Filter by minimum thresholds
      traders = traders.filter(
        (t) => t.realizedPnl > 1000 && t.tradesBuy > 2
      );

      console.log(`[TopTraderWatcher] Found ${traders.length} top traders after filtering`);

      for (const trader of traders) {
        const winRate = trader.tradesBuy + trader.tradesSell > 0
          ? trader.tradesBuy / (trader.tradesBuy + trader.tradesSell)
          : 0;

        await watchlistService.addTrader({
          wallet_address: trader.walletAddress,
          label: trader.label || `trader_${trader.walletAddress.slice(0, 8)}`,
          win_rate_7d: winRate,
          pnl_7d_usd: trader.realizedPnl,
          added_by_agent: "system"
        });
      }

      this.backoffMs = 1000;
    } catch (e) {
      console.error("[TopTraderWatcher] Error polling:", e);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      console.log(`[TopTraderWatcher] Backing off for ${this.backoffMs}ms`);
    }
  }

  private async fetchFromBirdeye(): Promise<TopTrader[]> {
    const url = "https://public-api.birdeye.so/defi/v2/tokens/top_traders?time_frame=24h&sort_by=realizedPnl&sort_type=desc&limit=15";
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey!,
      "accept": "application/json"
    };

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
    return items.map((item: any) => ({
      walletAddress: item.walletAddress,
      label: item.label,
      realizedPnl: item.realizedPnl || 0,
      tradesBuy: item.tradesBuy || 0,
      tradesSell: item.tradesSell || 0
    }));
  }
}