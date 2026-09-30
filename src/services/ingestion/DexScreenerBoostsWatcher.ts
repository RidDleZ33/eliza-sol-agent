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

interface PairInfo {
  symbol: string;
  volume24h: number;
  dexId: string;
}

export class DexScreenerBoostsWatcher implements IngestionWatcher {
  public name = "dexscreener_boosts";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private chainId: string;
  private pairCache: Map<string, PairInfo | null> = new Map();
  private readonly MAX_AGE_HOURS = 24;
  private readonly DEX_IDS = new Set(["raydium", "pumpswap", "pumpfun", "meteora", "orca"]);

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
      const discovered: { address: string; symbol: string; volume24h: number; dexId: string; ageH: number; pair?: any }[] = [];
      const now = Date.now();
      const maxAgeMs = this.MAX_AGE_HOURS * 60 * 60 * 1000;

      for (const boost of boosts) {
        if (discovered.length >= maxTokens) break;
        if (boost.chainId && boost.chainId !== this.chainId) continue;
        if (!boost.tokenAddress || boost.tokenAddress.length < 32) continue;

        // Get pair info (cached or fresh lookup)
        let info = this.pairCache.get(boost.tokenAddress);
        if (info === null) continue; // already skipped

        if (info === undefined) {
          // Fresh pair lookup
          try {
            const pairUrl = `https://api.dexscreener.com/latest/dex/tokens/${boost.tokenAddress}`;
            const pairResp = await fetch(pairUrl, { signal: AbortSignal.timeout(5000) });
            if (!pairResp.ok) {
              logger.info("INGESTION", this.name, "boost skip", { mint: boost.tokenAddress, reason: "pair_lookup_failed", status: pairResp.status });
              this.pairCache.set(boost.tokenAddress, null);
              continue;
            }
            const pairData = await pairResp.json();
            if (!pairData.pairs || pairData.pairs.length === 0) {
              logger.info("INGESTION", this.name, "boost skip", { mint: boost.tokenAddress, reason: "no_pair" });
              this.pairCache.set(boost.tokenAddress, null);
              continue;
            }

            // Prefer solana pair
            let pair = pairData.pairs.find((p: any) => p.chainId === "solana") || pairData.pairs[0];

            // Filter: DEX whitelist
            const dexId = pair.dexId || "unknown";
            if (!this.DEX_IDS.has(dexId)) {
              logger.info("INGESTION", this.name, "boost skip", { mint: boost.tokenAddress, reason: "bad_dex", dexId });
              this.pairCache.set(boost.tokenAddress, null);
              continue;
            }

            // Filter: pair age
            if (pair.pairCreatedAt) {
              const ageMs = now - pair.pairCreatedAt;
              const ageH = Math.floor(ageMs / 3600000);
              if (ageMs > maxAgeMs) {
                logger.info("INGESTION", this.name, "boost skip", { mint: boost.tokenAddress, reason: "old_pair", ageH });
                this.pairCache.set(boost.tokenAddress, null);
                continue;
              }
              info = {
                symbol: pair.baseToken?.symbol || boost.tokenAddress.slice(0, 6),
                volume24h: pair.volume?.h24 || 0,
                dexId,
                ageH,
              };
            } else {
              logger.info("INGESTION", this.name, "boost skip", { mint: boost.tokenAddress, reason: "no_created_at" });
              this.pairCache.set(boost.tokenAddress, null);
              continue;
            }
          } catch (e: any) {
            logger.warn("INGESTION", this.name, "boost pair lookup error", { mint: boost.tokenAddress, error: e.message });
            this.pairCache.set(boost.tokenAddress, null);
            continue;
          }
        }

        if (info) {
          discovered.push({
            address: boost.tokenAddress,
            symbol: info.symbol,
            volume24h: info.volume24h,
            dexId: info.dexId,
            ageH: info.ageH,
            pair: pair,
          });
        }
      }

      let newCount = 0;
      let dupCount = 0;
      for (const tok of discovered) {
        const inserted = await watchlistService.addDiscoveredToken(
          tok.address,
          tok.symbol,
          tok.volume24h,
          "ds_boost"
        );
        if (inserted) {
          newCount++;
          logger.info("INGESTION", this.name, "boost insert", {
            mint: tok.address,
            symbol: tok.symbol,
            dexId: tok.dexId,
            ageH: tok.ageH,
            volume24h: tok.volume24h,
          });
          // Phase 11A3N: stash pair at ingest so PA is warm on first Gamma tick
          if (tok.pair) {
            watchlistService.saveDexPair(tok.address, tok.pair);
          }
        } else {
          dupCount++;
        }
      }

      logger.info("INGESTION", this.name, "Poll complete", {
        total: boosts.length,
        discovered: discovered.length,
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