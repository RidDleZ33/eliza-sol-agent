import { watchlistService } from "../WatchlistService.ts";
import { configService } from "../ConfigService.ts";
import { logger } from "../LoggerService.ts";
import { IngestionWatcher } from "./IngestionWatcher.ts";
import { getIngestionInterval, getGmgnApiKey, isDryRun, getSolanaRpcUrl } from "../../utils/env.ts";
import { tradeExecutionService } from "../TradeExecutionService.ts";

const SOURCE = "mig_edge";
const ENDPOINT = "https://openapi.gmgn.ai/v1/trenches";
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_LIQUIDITY = 25000;
const MAX_LIQUIDITY = 100000;
const MIN_HOLDERS = 500;
const NUKE_MIN = 0.3;
const NUKE_MAX = 1.0;

// Phase 18A: Paper forward test of the majority-migration edge.
// Filter: top 10 and creator status present, liquidity $25k-$100k, 500+ holders.
// Inserted into watchlist but not routed through Alpha narrative gate.
// Paper buy only when dry-run is on; live buys are deferred to operator.

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

        // Phase 21A: Live middle band — check before insert
        const symbol = item.symbol || mint.slice(0, 6);
        const nuke = await this.checkNukeRatio(mint);
        if (!nuke.passed) {
          logger.info("INGESTION", this.name, "skip", { mint, reason: nuke.reason });
          continue;
        }
        logger.info("INGESTION", this.name, "nuke pass", { mint, ratio: nuke.ratio?.toFixed(3) });
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
      // Missing field is a skip.
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

      // Phase 21A: Live middle band — check before insert
      const nuke = await this.checkNukeRatio(mint);
      if (!nuke.passed) {
        logger.info("INGESTION", this.name, "skip", { mint, reason: nuke.reason });
        toDrop.push(mint);
        continue;
      }
      logger.info("INGESTION", this.name, "nuke pass", { mint, ratio: nuke.ratio?.toFixed(3) });
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

  /**
   * Phase 21A: Live middle band — require 0.3 <= nuke_ratio < 1.0.
   * Compute from top holder via RPC and pumpswap pair from DexScreener.
   */
  private async checkNukeRatio(mint: string): Promise<{ passed: boolean; reason?: string; ratio?: number }> {
    const rpcUrl = getSolanaRpcUrl();
    if (!rpcUrl) {
      return { passed: false, reason: "no_rpc" };
    }

    // Get pumpswap pair for priceNative and liquidity.quote
    let priceNative: number | null = null;
    let liqQuote: number | null = null;
    try {
      const dsUrl = "https://api.dexscreener.com/latest/dex/tokens/" + mint;
      const dsResp = await fetch(dsUrl);
      if (!dsResp.ok) {
        return { passed: false, reason: "ds_" + dsResp.status };
      }
      const dsJson = await dsResp.json();
      const pairs = dsJson?.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return { passed: false, reason: "no_pair" };
      }
      const pumpPair = pairs.find((p: any) => p.dexId === "pumpswap");
      if (!pumpPair) {
        return { passed: false, reason: "no_pair" };
      }
      priceNative = pumpPair.priceNative;
      if (!pumpPair.liquidity || !pumpPair.liquidity.quote) {
        return { passed: false, reason: "no_pair" };
      }
      liqQuote = pumpPair.liquidity.quote;
    } catch (e) {
      return { passed: false, reason: "rpc_error" };
    }

    if (!priceNative || !liqQuote) {
      return { passed: false, reason: "no_pair" };
    }

    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [mint] });
      const resp = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!resp.ok) {
        return { passed: false, reason: "rpc_" + resp.status };
      }
      const json = await resp.json();
      const accounts = json?.result?.value;
      if (!Array.isArray(accounts) || accounts.length < 2) {
        return { passed: false, reason: "no_holders" };
      }

      const topHolder = accounts[1];
      const amountStr = topHolder.uiAmountString;
      if (!amountStr) {
        return { passed: false, reason: "no_amount" };
      }
      const amount = parseFloat(amountStr);
      if (isNaN(amount)) {
        return { passed: false, reason: "parse_amount" };
      }

      const topHolderSol = amount * priceNative;
      const nukeRatio = topHolderSol / liqQuote;

      if (nukeRatio < NUKE_MIN) {
        return { passed: false, reason: "nuke_low", ratio: nukeRatio };
      }
      if (nukeRatio >= NUKE_MAX) {
        return { passed: false, reason: "nuke_high", ratio: nukeRatio };
      }
      return { passed: true, ratio: nukeRatio };
    } catch (e) {
      return { passed: false, reason: "rpc_error" };
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
