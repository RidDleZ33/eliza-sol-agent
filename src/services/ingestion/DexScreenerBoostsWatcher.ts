import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, ingestFlag, getDexscreenerChain, getMaxTrendingTokens } from "../../utils/env.ts";
import { requestAlphaTick } from "../../evaluators/AlphaNarrativeEvaluator.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";

interface BoostEntry {
  chainId: string;
  tokenAddress: string;
  description?: string;
  totalAmount?: number;
  tokenSymbol?: string;
}

export class DexScreenerBoostsWatcher implements IngestionWatcher {
  public name = "dexscreener_boosts";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private chainId: string;

  constructor() {
    this.chainId = getDexscreenerChain();
  }

  start() {
    logger.info("INGESTION", this.name, "Starting");
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) clearInterval(this.intervalId);
    const intervalMs = getIngestionInterval();
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
      logger.debug("INGESTION", this.name, "Polling");

      const url = "https://api.dexscreener.com/token-boosts/latest/v1";
      logger.info("INGESTION", this.name, "Polling token boosts");

      const response = await fetchWithRetry(url);
      if (!response.ok) {
        throw new Error(`DexScreener ${response.status} for boosts endpoint`);
      }

      const boosts: BoostEntry[] = await response.json();

      // Filter by chain and cap
      const maxTokens = getMaxTrendingTokens();
      const discovered: { address: string; symbol: string }[] = [];
      for (const boost of boosts) {
        if (boost.chainId && boost.chainId !== this.chainId) continue;
        if (!boost.tokenAddress || boost.tokenAddress.length < 32) continue;

        const symbol = boost.tokenSymbol || boost.tokenAddress.slice(0, 6);
        discovered.push({ address: boost.tokenAddress, symbol });
        if (discovered.length >= maxTokens) break;
      }

      let newCount = 0;
      let dupCount = 0;
      for (const tok of discovered) {
        const inserted = await watchlistService.addDiscoveredToken(
          tok.address,
          tok.symbol,
          0,
          "ds_boost"
        );
        if (inserted) {
          newCount++;
        } else {
          dupCount++;
        }
      }

      logger.info("INGESTION", this.name, "Poll complete", {
        total: discovered.length,
        new: newCount,
        duplicates: dupCount,
      });

      // Wake Alpha only on real inserts
      if (newCount > 0) {
        requestAlphaTick();
      }

      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", this.name, "Backing off", { backoffMs: this.backoffMs });
    }
  }
}
