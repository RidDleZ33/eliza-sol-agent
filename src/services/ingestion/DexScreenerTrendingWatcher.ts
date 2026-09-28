import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import {
  fetchDexJson,
  pairsFromUnknown,
  toDiscovered,
} from "./dexscreenerPairs.ts";
import {
  getDexscreenerChain,
  getDexscreenerTrendingPeriod,
  ingestFlag,
  getMaxTrendingTokens,
} from "../../utils/env.ts";

export class DexScreenerTrendingWatcher implements IngestionWatcher {
  public name = "dexscreener_trending";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private chainId: string;
  private period: string;
  private includeBullish: boolean;

  constructor() {
    this.chainId = getDexscreenerChain();
    this.period = getDexscreenerTrendingPeriod();
    this.includeBullish = ingestFlag("INGEST_DEXSCREENER_TRENDING_BULLISH");
  }

  private buildTrendingUrl(): string {
    return `https://api.dexscreener.com/tokens/trending/v1?chainId=${this.chainId}&timePeriod=${this.period}`;
  }

  private buildBullishUrl(): string {
    return `https://api.dexscreener.com/tokens/trending-bullish/v1?chainId=${this.chainId}&timePeriod=${this.period}`;
  }

  start() {
    logger.info("INGESTION", this.name, "Starting", { period: this.period, includeBullish: this.includeBullish });
    this.poll();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.intervalId) clearInterval(this.intervalId);
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
      logger.debug("INGESTION", this.name, "Polling");

      const trendingUrl = this.buildTrendingUrl();
      logger.info("INGESTION", this.name, "Polling trending", { url: trendingUrl });

      let raw = await fetchDexJson(trendingUrl);
      let pairs = pairsFromUnknown(raw);

      if (this.includeBullish) {
        const bullishUrl = this.buildBullishUrl();
        logger.info("INGESTION", this.name, "Polling bullish", { url: bullishUrl });
        try {
          const bullishRaw = await fetchDexJson(bullishUrl);
          const bullishPairs = pairsFromUnknown(bullishRaw);
          // Union by mint address
          const mints = new Set<string>();
          for (const p of pairs) {
            const addr = p.baseToken?.address || p.tokenAddress || p.address;
            if (addr) mints.add(addr);
          }
          for (const bp of bullishPairs) {
            const addr = bp.baseToken?.address || bp.tokenAddress || bp.address;
            if (addr && !mints.has(addr)) {
              pairs.push(bp);
              mints.add(addr);
            }
          }
        } catch (e: any) {
          logger.warn("INGESTION", this.name, "Failed to fetch bullish board", { error: e.message });
        }
      }

      const discovered: { address: string; symbol: string; volume24h: number }[] = [];
      for (const pair of pairs) {
        const tok = toDiscovered(pair, this.chainId);
        if (tok) {
          discovered.push({
            address: tok.address,
            symbol: tok.symbol,
            volume24h: tok.volume24h,
          });
        }
        if (discovered.length >= getMaxTrendingTokens()) break;
      }

      let newCount = 0;
      let dupCount = 0;
      for (const tok of discovered) {
        const inserted = await watchlistService.addDiscoveredToken(
          tok.address,
          tok.symbol,
          tok.volume24h,
          "ds_trending"
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
      this.backoffMs = 1000;
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      logger.warn("INGESTION", this.name, "Backing off", { backoffMs: this.backoffMs });
    }
  }
}
