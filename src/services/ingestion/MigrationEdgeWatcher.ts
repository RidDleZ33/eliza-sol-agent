import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, getGmgnApiKey } from "../../utils/env.ts";
import { tradeExecutionService } from "../TradeExecutionService.ts";
import { recipesEvaluator, type CandidateFacts } from "../RecipesEvaluator.ts";

const SOURCE = "mig_edge";
const ENDPOINT = "https://openapi.gmgn.ai/v1/trenches";
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_LIQUIDITY = 25000;
const MAX_LIQUIDITY = 100000;
const MIN_HOLDERS = 500;

// Phase 18A/24G: Majority-migration edge with live buy.
// Filter: top 10 and creator status present, liquidity $25k-$100k, 500+ holders.
// Inserted into watchlist and routed to executeBuy (paper or live based on mode).

interface PendingItem {
  mint: string;
  symbol: string;
  completeTimestamp: number;
  top10Rate?: number;
  creatorStatus?: string;
  liquidity?: number;
  holderCount?: number;
}

export class MigrationEdgeWatcher implements IngestionWatcher {
  public name = "migration_edge";
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private maxBackoffMs = 60000;
  // Items seen early; re-check next poll once the 5-min cool-off passes.
  private pending: Map<string, PendingItem> = new Map();

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

      // Re-check items that were too early last poll.
      await this.recheckPending();

      const gmgnApiKey = getGmgnApiKey();
      if (!gmgnApiKey) {
        logger.warn("INGESTION", this.name, "GMGN key missing, skipping poll");
        return;
      }

      const timestampSecs = Math.floor(Date.now() / 1000);
      const clientId = `${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 10)}`;

      const url = new URL(ENDPOINT);
      url.searchParams.set("timestamp", String(timestampSecs));
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("chain", "sol");

      const body = {
        version: "v2",
        completed: {
          filters: ["offchain", "onchain"],
          launchpad_platform_v2: true,
          launchpad_platform: ["Pump.fun"],
          quote_address_type: [4, 5, 3, 1, 13, 0],
          limit: 50,
        },
      };

      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-APIKEY": gmgnApiKey,
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 429) {
        logger.warn("INGESTION", this.name, "Rate limited, backing off");
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        return;
      }

      if (!resp.ok) {
        let snippet = "";
        try {
          const text = await resp.text();
          snippet = text.slice(0, 200).replace(/\n/g, " ").trim();
        } catch {
          // ignore
        }
        logger.error("INGESTION", this.name, "Trenches call failed", { status: resp.status, body: snippet });
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        return;
      }

      let json: any;
      try {
        json = await resp.json();
      } catch (e: any) {
        logger.error("INGESTION", this.name, "Parse failed", { error: e.message });
        return;
      }

      const list = json?.data?.completed;
      if (!Array.isArray(list)) {
        logger.error("INGESTION", this.name, "No completed array", { keys: json ? Object.keys(json) : null });
        return;
      }

      logger.info("INGESTION", this.name, "Poll complete", { candidates: list.length });

      const now = Date.now();
      let inserted = 0;

      for (const item of list) {
        const mint = item?.address;
        if (!mint) continue;

        if (typeof item.complete_timestamp !== "number") {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "no_complete_ts" });
          continue;
        }

        const completeMs = item.complete_timestamp * 1000;
        const elapsed = now - completeMs;
        if (elapsed < COOLDOWN_MS) {
          // Too early; store item for re-evaluation after cool-off.
          const symbol = item.symbol || mint.slice(0, 6);
          let liq = typeof item.liquidity === "number" ? item.liquidity : parseFloat(item.liquidity);
          if (isNaN(liq)) liq = undefined;
          this.pending.set(mint, {
            mint,
            symbol,
            completeTimestamp: completeMs,
            top10Rate: typeof item.top_10_holder_rate === "number" ? item.top_10_holder_rate : undefined,
            creatorStatus: item.creator_token_status,
            liquidity: liq,
            holderCount: typeof item.holder_count === "number" ? item.holder_count : undefined,
          });
          logger.info("INGESTION", this.name, "skip", { mint, reason: "cooloff", elapsedSec: Math.floor(elapsed / 1000) });
          continue;
        }

        const symbol = item.symbol || mint.slice(0, 6);

        // PHASE 30B: When recipes are matching, bypass hardcoded liq/holders/top10/creator
        // skips — the recipe gates are the only filter. Build facts from whatever fields
        // are present; missing fields become undefined. Old path remains when recipes are off.
        let facts: any | undefined;
        if (recipesEvaluator.isMatching() && recipesEvaluator.getEnabledCount() > 0) {
          // Recipe path: no hardcoded skips, build best-effort facts
          const liq = typeof item.liquidity === "number" ? item.liquidity : parseFloat(item.liquidity);
          facts = {
            mint,
            symbol,
            source: SOURCE,
            liq_usd: isNaN(liq) ? undefined : liq,
            holders: typeof item.holder_count === "number" ? item.holder_count : undefined,
            top10_rate: typeof item.top_10_holder_rate === "number" ? item.top_10_holder_rate : undefined,
            creator_status: item.creator_token_status,
          };
          // Log which facts are present for traceability
          const present: string[] = [];
          if (facts.liq_usd !== undefined) present.push("liq");
          if (facts.holders !== undefined) present.push("holders");
          if (facts.top10_rate !== undefined) present.push("top10");
          if (facts.creator_status !== undefined) present.push("creator");
          logger.info("INGESTION", this.name, "recipe_eval", { mint, facts_present: present.join(",") });
        } else {
          // Legacy path: keep all hardcoded skips
          if (typeof item.top_10_holder_rate !== "number") {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "no_top10" });
            continue;
          }
          if (!item.creator_token_status) {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "no_creator" });
            continue;
          }
          const liq = typeof item.liquidity === "number" ? item.liquidity : parseFloat(item.liquidity);
          if (isNaN(liq)) {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "no_liq" });
            continue;
          }
          if (liq < MIN_LIQUIDITY) {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "thin_liq", liq });
            continue;
          }
          if (liq >= MAX_LIQUIDITY) {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "fat_liq", liq });
            continue;
          }
          if (typeof item.holder_count !== "number") {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "low_holders" });
            continue;
          }
          if (item.holder_count < MIN_HOLDERS) {
            logger.info("INGESTION", this.name, "skip", { mint, reason: "low_holders", count: item.holder_count });
            continue;
          }
          facts = {
            mint,
            symbol,
            source: SOURCE,
            liq_usd: liq,
            holders: item.holder_count,
            top10_rate: item.top_10_holder_rate,
            creator_status: item.creator_token_status,
          };
        }

        if (facts) {
          const ok = await watchlistService.addDiscoveredToken(mint, symbol, 0, SOURCE);
          if (ok) {
            inserted++;
            logger.info("INGESTION", this.name, "insert", { mint, symbol, liq: facts.liq_usd, top10: facts.top10_rate });
            this.maybeBuy(mint, symbol, facts);
          }
        }
      }

      this.backoffMs = 1000;
      logger.info("INGESTION", this.name, "Poll done", { inserted });
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Error polling", { error: e.message });
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
  }

  private async recheckPending() {
    const now = Date.now();
    const toDrop: string[] = [];

    for (const [mint, item] of this.pending.entries()) {
      if (now - item.completeTimestamp < COOLDOWN_MS) continue;

      let facts: any | undefined;

      if (recipesEvaluator.isMatching() && recipesEvaluator.getEnabledCount() > 0) {
        // PHASE 30B: Recipe path — no hardcoded skips, build best-effort facts
        facts = {
          mint,
          symbol: item.symbol,
          source: SOURCE,
          liq_usd: item.liquidity,
          holders: item.holderCount,
          top10_rate: item.top10Rate,
          creator_status: item.creatorStatus,
        };
        const present: string[] = [];
        if (facts.liq_usd !== undefined) present.push("liq");
        if (facts.holders !== undefined) present.push("holders");
        if (facts.top10_rate !== undefined) present.push("top10");
        if (facts.creator_status !== undefined) present.push("creator");
        logger.info("INGESTION", this.name, "recipe_eval", { mint, facts_present: present.join(",") });
      } else {
        // Legacy path: keep all hardcoded skips
        if (item.top10Rate === undefined) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "no_top10" });
          toDrop.push(mint);
          continue;
        }
        if (!item.creatorStatus) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "no_creator" });
          toDrop.push(mint);
          continue;
        }
        if (item.liquidity === undefined) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "no_liq" });
          toDrop.push(mint);
          continue;
        }
        if (item.liquidity < MIN_LIQUIDITY) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "thin_liq", liq: item.liquidity });
          toDrop.push(mint);
          continue;
        }
        if (item.liquidity >= MAX_LIQUIDITY) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "fat_liq", liq: item.liquidity });
          toDrop.push(mint);
          continue;
        }
        if (item.holderCount === undefined) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "low_holders" });
          toDrop.push(mint);
          continue;
        }
        if (item.holderCount < MIN_HOLDERS) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "low_holders", count: item.holderCount });
          toDrop.push(mint);
          continue;
        }

        facts = {
          mint,
          symbol: item.symbol,
          source: SOURCE,
          liq_usd: item.liquidity,
          holders: item.holderCount,
          top10_rate: item.top10Rate,
          creator_status: item.creatorStatus,
        };
      }

      if (facts) {
        const ok = await watchlistService.addDiscoveredToken(mint, item.symbol, 0, SOURCE);
        if (ok) {
          logger.info("INGESTION", this.name, "insert", { mint, symbol: item.symbol, liq: facts.liq_usd, top10: facts.top10_rate });
          this.maybeBuy(mint, item.symbol, facts);
        }
      }
      toDrop.push(mint);
    }

    for (const mint of toDrop) {
      this.pending.delete(mint);
    }
  }

  private async maybeBuy(mint: string, symbol: string, facts?: any) {
    logger.info("INGESTION", this.name, "mig_edge buy", { mint, symbol });

    // PHASE 30A: When recipes are enabled and there are enabled recipes,
    // no recipe match means no buy (gate). Otherwise fall through to
    // the hardcoded path so the desk does not go dark during the switch.
    let strategyId: string | undefined;
    if (facts && recipesEvaluator.isMatching()) {
      const enabledCount = recipesEvaluator.getEnabledCount();
      if (enabledCount > 0) {
        const candidate: CandidateFacts = {
          mint,
          symbol,
          source: SOURCE,
          liq_usd: facts.liq_usd,
          holders: facts.holders,
          top10_rate: facts.top10_rate,
          creator_status: facts.creator_status,
          nuke_ratio: facts.nuke_ratio,
        };

        const matches = recipesEvaluator.evaluateCandidate(candidate);
        const passing = matches.filter(m => m.pass);

        if (passing.length > 0) {
          strategyId = passing[0].recipeId;
          logger.info("RECIPES", "maybeBuy", "candidate matched recipe", { mint, symbol, strategyId });
        } else {
          logger.info("RECIPES", "maybeBuy", "no recipe match", { mint, symbol });
          return;
        }
      }
    }

    try {
      const result = await tradeExecutionService.executeBuy(
        mint,
        symbol,
        0.75,
        "mig_edge",
        undefined,
        strategyId
      );
      if (result.success) {
        logger.info("INGESTION", this.name, "buy ok", { mint, symbol, strategyId });
      } else {
        logger.warn("INGESTION", this.name, "buy failed", { mint, symbol, error: result.error });
      }
    } catch (e: any) {
      logger.error("INGESTION", this.name, "buy error", { mint, symbol, error: e.message });
    }
  }
}

export const migrationEdgeSource = {
  flag: "INGEST_MIGRATION_EDGE",
  source: SOURCE,
  defaults: { INGEST_MIGRATION_EDGE: "false" },
  create: () => new MigrationEdgeWatcher(),
};
