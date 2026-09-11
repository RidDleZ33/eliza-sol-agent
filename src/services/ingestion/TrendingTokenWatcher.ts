import { watchlistService } from "../WatchlistService.ts";
import { getBirdeyeApiKey } from "../../utils/env.ts";
import { configService } from "../ConfigService.ts";

interface TrendingToken {
  address: string;
  symbol: string;
  volume24h: number;
  liquidity?: number;
}

export class TrendingTokenWatcher {
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
    console.log(`[TrendingTokenWatcher] Next poll in ${intervalMs}ms`);
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log("[TrendingTokenWatcher] Stopped");
  }

  private async poll() {
    try {
      console.log("[TrendingTokenWatcher] Polling for trending tokens...");
      let tokens: TrendingToken[] = [];

      if (this.birdeyeApiKey) {
        tokens = await this.fetchFromBirdeye();
      }

      if (!tokens || tokens.length === 0) {
        console.log("[TrendingTokenWatcher] Birdeye empty, trying DexScreener fallback");
        tokens = await this.fetchFromDexScreener();
      }

      console.log(`[TrendingTokenWatcher] Found ${tokens.length} trending tokens`);

      for (const token of tokens) {
        await watchlistService.addToken({
          mint_address: token.address,
          symbol: token.symbol,
          narrative_score: 0.5, // Will be updated by Alpha after sentiment analysis
          volume_24h: token.volume24h,
          added_by_agent: "system"
        });
      }

      this.backoffMs = 1000;
    } catch (e) {
      console.error("[TrendingTokenWatcher] Error polling:", e);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      console.log(`[TrendingTokenWatcher] Backing off for ${this.backoffMs}ms`);
    }
  }

  private async fetchFromBirdeye(): Promise<TrendingToken[]> {
    const url = "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=10";
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
      address: item.address,
      symbol: item.symbol,
      volume24h: item.volume24h || 0,
      liquidity: item.liquidity
    }));
  }

  private async fetchFromDexScreener(): Promise<TrendingToken[]> {
    const url = "https://api.dexscreener.com/latest/dex/search?q=solana&limit=10";

    const response = await fetch(url);

    if (response.status === 429) {
      throw new Error("Rate limited by DexScreener API");
    }

    if (!response.ok) {
      throw new Error(`DexScreener API returned ${response.status}`);
    }

    const data = await response.json();

    const pairs = data.pairs || [];
    return pairs
      .filter((pair: any) => pair.chainId === "solana")
      .map((pair: any) => ({
        address: pair.baseToken.address,
        symbol: pair.baseToken.symbol,
        volume24h: pair.volume?.h24?.usd || 0,
        liquidity: pair.liquidity?.usd || 0
      }));
  }
}