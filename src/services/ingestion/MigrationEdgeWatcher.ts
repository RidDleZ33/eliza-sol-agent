import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, getGmgnApiKey, isDryRun } from "../../utils/env.ts";
import { tradeExecutionService } from "../TradeExecutionService.ts";

const SOURCE = "mig_edge";
const ENDPOINT = "https://openapi.gmgn.ai/v1/trenches";
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_LIQUIDITY = 25000;
const TOP10_MAX = 0.2;

// Phase 18A: Paper forward test of the majority-migration edge.
// Filter: top 10 < 20%, creator already closed, book thick enough.
// Inserted into watchlist but not routed through Alpha narrative gate.
// Paper buy only when dry-run is on; live buys are deferred to operator.

interface PendingItem {
  mint: string;
  symbol: string;
  completeTimestamp: number;
  top10Rate?: number;
  creatorStatus?: string;
  liquidity?: number;
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
          });
          logger.info("INGESTION", this.name, "skip", { mint, reason: "cooloff", elapsedSec: Math.floor(elapsed / 1000) });
          continue;
        }

        if (typeof item.top_10_holder_rate !== "number") {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "no_top10" });
          continue;
        }
        if (item.top_10_holder_rate >= TOP10_MAX) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "top10", rate: item.top_10_holder_rate });
          continue;
        }

        if (item.creator_token_status !== "creator_close") {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "creator_status", status: item.creator_token_status });
          continue;
        }

        const liq = typeof item.liquidity === "number" ? item.liquidity : parseFloat(item.liquidity);
        if (isNaN(liq) || liq < MIN_LIQUIDITY) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: "thin_liq", liq: isNaN(liq) ? "N/A" : liq });
          continue;
        }

        // Filter passed. Insert.
        const symbol = item.symbol || mint.slice(0, 6);
        const ok = await watchlistService.addDiscoveredToken(mint, symbol, 0, SOURCE);
        if (ok) {
          inserted++;
          logger.info("INGESTION", this.name, "insert", { mint, symbol, liq, top10: item.top_10_holder_rate });
          // Paper buy if dry-run is on. Do not wake Alpha.
          this.maybePaperBuy(mint, symbol);
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

      // Cool-off passed; evaluate stored item through same filters.
      // Missing top10 is a skip — do not treat as pass.
      if (item.top10Rate === undefined) {
        logger.info("INGESTION", this.name, "skip", { mint, reason: "no_top10" });
        toDrop.push(mint);
        continue;
      }
      if (item.top10Rate >= TOP10_MAX) {
        logger.info("INGESTION", this.name, "skip", { mint, reason: "top10", rate: item.top10Rate });
        toDrop.push(mint);
        continue;
      }
      if (item.creatorStatus !== "creator_close") {
        logger.info("INGESTION", this.name, "skip", { mint, reason: "creator_status", status: item.creatorStatus });
        toDrop.push(mint);
        continue;
      }
      if (item.liquidity === undefined || item.liquidity < MIN_LIQUIDITY) {
        logger.info("INGESTION", this.name, "skip", { mint, reason: "thin_liq", liq: item.liquidity });
        toDrop.push(mint);
        continue;
      }

      // Filter passed.
      const ok = await watchlistService.addDiscoveredToken(mint, item.symbol, 0, SOURCE);
      if (ok) {
        logger.info("INGESTION", this.name, "insert", { mint, symbol: item.symbol, liq: item.liquidity, top10: item.top10Rate });
        this.maybePaperBuy(mint, item.symbol);
      }
      toDrop.push(mint);
    }

    for (const mint of toDrop) {
      this.pending.delete(mint);
    }
  }

  private async maybePaperBuy(mint: string, symbol: string) {
    if (!isDryRun()) {
      logger.info("INGESTION", this.name, "mig_edge skip live", { mint, symbol });
      return;
    }

    logger.info("INGESTION", this.name, "mig_edge paper buy", { mint, symbol });
    try {
      const result = await tradeExecutionService.executeBuy(
        mint,
        symbol,
        0.75,
        "mig_edge"
      );
      if (result.success) {
        logger.info("INGESTION", this.name, "Paper buy ok", { mint, symbol });
      } else {
        logger.warn("INGESTION", this.name, "Paper buy failed", { mint, symbol, error: result.error });
      }
    } catch (e: any) {
      logger.error("INGESTION", this.name, "Paper buy error", { mint, symbol, error: e.message });
    }
  }
}

export const migrationEdgeSource = {
  flag: "INGEST_MIGRATION_EDGE",
  source: SOURCE,
  defaults: { INGEST_MIGRATION_EDGE: "false" },
  create: () => new MigrationEdgeWatcher(),
};
