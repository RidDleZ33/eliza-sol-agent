import { watchlistService } from "../WatchlistService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, getDexscreenerChain, getMaxTrendingTokens } from "../../utils/env.ts";
import { requestAlphaTick } from "../../evaluators/AlphaNarrativeEvaluator.ts";
import { fetchWithRetry } from "../../utils/circuitBreaker.ts";

const SOURCE = "ds_profile";

interface ProfileEntry {
  chainId: string;
  tokenAddress: string;
}

interface PairInfo {
  symbol: string;
  volume24h: number;
  dexId: string;
  ageH: number;
}

export class DexScreenerProfilesWatcher implements IngestionWatcher {
  public name = "dexscreener_profiles";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  private chainId: string;
  private pairCache: Map<string, PairInfo | null> = new Map();
  private readonly MAX_AGE_HOURS = 6;
  private readonly DEX_IDS = new Set(["raydium", "pumpswap", "meteora", "orca"]);
  private readonly NOT_BONDED_DXS = new Set(["pumpfun"]);

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

      const url = "https://api.dexscreener.com/token-profiles/latest/v1";
      logger.info("INGESTION", this.name, "Polling token profiles");

      const response = await fetchWithRetry(url);
      if (!response.ok) {
        throw new Error(`DexScreener ${response.status} for profiles endpoint`);
      }

      const profiles: ProfileEntry[] = await response.json();

      const maxTokens = getMaxTrendingTokens();
      const discovered: { address: string; symbol: string; volume24h: number }[] = [];
      const now = Date.now();
      const maxAgeMs = this.MAX_AGE_HOURS * 60 * 60 * 1000;

      for (const profile of profiles) {
        if (discovered.length >= maxTokens) break;
        if (profile.chainId && profile.chainId !== this.chainId) continue;
        if (!profile.tokenAddress || profile.tokenAddress.length < 32) continue;

        let info = this.pairCache.get(profile.tokenAddress);
        if (info === null) continue;

        if (info === undefined) {
          try {
            const pairUrl = `https://api.dexscreener.com/latest/dex/tokens/${profile.tokenAddress}`;
            const pairResp = await fetch(pairUrl, { signal: AbortSignal.timeout(5000) });
            if (!pairResp.ok) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "pair_lookup_failed", status: pairResp.status });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }
            const pairData = await pairResp.json();
            if (!pairData.pairs || pairData.pairs.length === 0) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "no_pair" });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }

            const pair = pairData.pairs.find((p: any) => p.chainId === "solana") || pairData.pairs[0];
            const dexId = pair.dexId || "unknown";

            if (this.NOT_BONDED_DXS.has(dexId)) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "pumpfun" });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }

            if (!this.DEX_IDS.has(dexId)) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "bad_dex", dexId });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }

            if (!pair.pairCreatedAt) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "no_created_at" });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }

            const ageMs = now - pair.pairCreatedAt;
            const ageH = Math.floor(ageMs / 3600000);
            if (ageMs > maxAgeMs) {
              logger.info("INGESTION", this.name, "profile skip", { mint: profile.tokenAddress, reason: "old_pair", ageH });
              this.pairCache.set(profile.tokenAddress, null);
              continue;
            }

            info = {
              symbol: pair.baseToken?.symbol || profile.tokenAddress.slice(0, 6),
              volume24h: pair.volume?.h24 || 0,
              dexId,
              ageH,
            };
            this.pairCache.set(profile.tokenAddress, { ...info, _pair: pair });
          } catch (e: any) {
            logger.warn("INGESTION", this.name, "profile pair lookup error", { mint: profile.tokenAddress, error: e.message });
            this.pairCache.set(profile.tokenAddress, null);
            continue;
          }
        }

        if (info) {
          discovered.push({
            address: profile.tokenAddress,
            symbol: info.symbol,
            volume24h: info.volume24h,
          });
        }
      }

      let newCount = 0;
      let dupCount = 0;
      for (let i = 0; i < discovered.length; i++) {
        const tok = discovered[i];
        const inserted = await watchlistService.addDiscoveredToken(
          tok.address,
          tok.symbol,
          tok.volume24h,
          SOURCE
        );
        if (inserted) {
          newCount++;
          logger.info("INGESTION", this.name, "profile insert", {
            mint: tok.address,
            symbol: tok.symbol,
            volume24h: tok.volume24h,
          });
          const cached = this.pairCache.get(tok.address);
          if (cached && cached._pair && cached._pair.priceUsd) {
            watchlistService.saveDexPair(tok.address, cached._pair);
          }
        } else {
          dupCount++;
        }
      }

      logger.info("INGESTION", this.name, "Poll complete", {
        total: profiles.length,
        discovered: discovered.length,
        new: newCount,
        duplicates: dupCount,
      });

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

export const dexScreenerProfilesSource = {
  flag: "INGEST_DEXSCREENER_PROFILES",
  source: SOURCE,
  defaults: { INGEST_DEXSCREENER_PROFILES: "false" },
  create: () => new DexScreenerProfilesWatcher(),
};
