import { getTwitterBearerToken } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

export interface SocialTelemetry {
  mintAddress: string;
  symbol: string;
  hasSocialLinks: boolean;
  socialPlatforms: string[]; // ['twitter', 'telegram', 'website']
  isDexBoosted: boolean;
  buySellRatio5m: number;
  txAcceleration5mVs1h: number; // >1 means volume is speeding up
  tweetVolume1h?: number;
  botLikelihoodScore: number; // 0.0 (Organic) to 1.0 (Pure Bot Farm)
  rawTextSamples: string[];
}

export class SocialEvaluatorService {
  private twitterBearerToken: string | undefined;

  constructor() {
    this.twitterBearerToken = getTwitterBearerToken();
  }

  async evaluateToken(mintAddress: string, symbol: string): Promise<SocialTelemetry> {
    logger.info("SOCIAL", "SocialEvaluator", "Starting social evaluation", { symbol, mintAddress });

    let telemetry: SocialTelemetry = {
      mintAddress,
      symbol,
      hasSocialLinks: false,
      socialPlatforms: [],
      isDexBoosted: false,
      buySellRatio5m: 1.0,
      txAcceleration5mVs1h: 1.0,
      botLikelihoodScore: 0.0,
      rawTextSamples: [],
    };

    try {
      const dexData = await this.fetchDexScreenerData(mintAddress);
      Object.assign(telemetry, dexData);
    } catch (e) {
      logger.warn("SOCIAL", "SocialEvaluator", "DexScreener fetch failed", { symbol, error: e.message });
    }

    try {
      if (this.twitterBearerToken) {
        const twitterData = await this.fetchTwitterData(symbol, mintAddress);
        telemetry.tweetVolume1h = twitterData.tweetVolume;
        telemetry.rawTextSamples = twitterData.recentTweets;
        telemetry.botLikelihoodScore = this.calculateBotScore(twitterData.recentTweets);
      }
    } catch (e) {
      logger.warn("SOCIAL", "SocialEvaluator", "Twitter fetch failed", { symbol, error: e.message });
    }

    return telemetry;
  }

  private async fetchDexScreenerData(mintAddress: string) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);

    const data = await response.json();
    const pair = data?.pairs?.[0];
    if (!pair) throw new Error("No DexScreener pair data");

    const socials = pair.info?.socials || [];
    const websites = pair.info?.websites || [];
    const socialPlatforms = [
      ...socials.map((s: any) => s.type?.toLowerCase()),
      ...(websites.length > 0 ? ["website"] : [])
    ];

    const txs = pair.txs || {};
    const buys5m = txs.m5?.buys || 0;
    const sells5m = txs.m5?.sells || 0;
    const buys1h = txs.h1?.buys || 1;
    const sells1h = txs.h1?.sells || 1;

    const buySellRatio5m = sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2.0 : 1.0;
    const total5m = buys5m + sells5m;
    const total1hAvg5m = (buys1h + sells1h) / 12;
    const txAcceleration5mVs1h = total1hAvg5m > 0 ? total5m / total1hAvg5m : 1.0;

    return {
      hasSocialLinks: socialPlatforms.length > 0,
      socialPlatforms: Array.from(new Set(socialPlatforms)),
      isDexBoosted: (pair.boosts?.active || 0) > 0,
      buySellRatio5m,
      txAcceleration5mVs1h
    };
  }

  private async fetchTwitterData(symbol: string, mintAddress: string) {
    // Search strictly for cashtag or contract address while excluding common noise
    const query = encodeURIComponent(`($${symbol} OR ${mintAddress}) -is:retweet -giveaway -airdrop`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,author_id,public_metrics`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.twitterBearerToken}`,
        "User-Agent": "AICommittee/1.0",
      },
    });

    if (!response.ok) throw new Error(`Twitter API HTTP ${response.status}`);

    const data = await response.json();
    const tweets = data.data || [];

    return {
      tweetVolume: tweets.length,
      recentTweets: tweets.map((t: any) => t.text),
    };
  }

  private calculateBotScore(tweets: string[]): number {
    if (tweets.length === 0) return 0.5;

    let duplicateCount = 0;
    const seenSnippets = new Set<string>();

    for (const tweet of tweets) {
      // Normalize text to detect copy-paste bot spam
      const normalized = tweet.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
      if (seenSnippets.has(normalized)) {
        duplicateCount++;
      } else {
        seenSnippets.add(normalized);
      }
    }

    // High duplicate ratio indicates bot farming
    return Math.min(1.0, duplicateCount / tweets.length);
  }
}

export const socialEvaluatorService = new SocialEvaluatorService();
export default socialEvaluatorService;
