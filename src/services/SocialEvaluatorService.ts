import { getTwitterBearerToken } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

export interface SocialTelemetry {
  mintAddress: string;
  symbol: string;
  hasSocialLinks: boolean;
  socialPlatforms: string[];
  isDexBoosted: boolean;
  buySellRatio5m: number;
  txAcceleration5mVs1h: number;
  tweetVolume1h: number;
  twitterQueried: boolean;
  botLikelihoodScore: number;
  cashtagSpamRatio: number;
  rawTextSamples: string[];
  dexMiss: boolean;
  pumpFunCommentCount?: number;
}

export class SocialEvaluatorService {
  private twitterBearerToken: string | undefined;
  private noBearerLogged = false;

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
      tweetVolume1h: 0,
      twitterQueried: false,
      botLikelihoodScore: 0.0,
      cashtagSpamRatio: 0.0,
      rawTextSamples: [],
      dexMiss: false,
    };

    const [dexData, twitterData] = await Promise.allSettled([
      this.fetchDexScreenerData(mintAddress),
      this.fetchTwitterData(symbol, mintAddress)
    ]);

    if (dexData.status === "fulfilled") {
      Object.assign(telemetry, dexData.value);
    } else {
      telemetry.dexMiss = true;
    }
    if (twitterData.status === "fulfilled") {
      telemetry.tweetVolume1h = twitterData.value.tweetVolume;
      telemetry.twitterQueried = twitterData.value.queried;
      telemetry.rawTextSamples = twitterData.value.recentTweets;
      
      const metrics = this.analyzeTweetQuality(twitterData.value.recentTweets, twitterData.value.queried);
      telemetry.botLikelihoodScore = metrics.botScore;
      telemetry.cashtagSpamRatio = metrics.cashtagSpamRatio;
    }

    return telemetry;
  }

  private async fetchDexScreenerData(mintAddress: string) {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (!response.ok) {
      logger.info("SOCIAL", "SocialEvaluator", `dex pair not found chain=solana mint=${mintAddress} status=${response.status}`);
      return { dexMiss: true };
    }

    const data = await response.json();
    const pair = data?.pairs?.[0];
    if (!pair) {
      logger.info("SOCIAL", "SocialEvaluator", `dex pair not found chain=solana mint=${mintAddress} reason=no pairs`);
      return { dexMiss: true };
    }

    const socials = pair.info?.socials || [];
    const websites = pair.info?.websites || [];
    const socialPlatforms = Array.from(new Set([
      ...socials.map((s: any) => s.type?.toLowerCase()),
      ...(websites.length > 0 ? ["website"] : [])
    ]));

    const txs = pair.txns || pair.txs || {};
    const buys5m = txs.m5?.buys || 0;
    const sells5m = txs.m5?.sells || 0;
    const total1hAvg5m = ((txs.h1?.buys || 0) + (txs.h1?.sells || 0)) / 12;

    logger.info("SOCIAL", "SocialEvaluator", `dex pair found chain=${pair.chainId} dexId=${pair.dexId} hasInfo=${pair.info !== null && pair.info !== undefined} platforms=${socialPlatforms.join(",") || "none"} buys5m=${buys5m} sells5m=${sells5m}`);

    return {
      hasSocialLinks: socialPlatforms.length > 0,
      socialPlatforms,
      isDexBoosted: (pair.boosts?.active || 0) > 0,
      buySellRatio5m: sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2.0 : 1.0,
      txAcceleration5mVs1h: total1hAvg5m > 0 ? (buys5m + sells5m) / total1hAvg5m : 1.0,
      dexMiss: false
    };
  }

  private async fetchTwitterData(symbol: string, mintAddress: string) {
    if (!this.twitterBearerToken) {
      if (!this.noBearerLogged) {
        logger.info("SOCIAL", "SocialEvaluator", "twitter skip: NO_BEARER");
        this.noBearerLogged = true;
      }
      return { tweetVolume: 0, recentTweets: [], queried: false };
    }

    const query = encodeURIComponent(`($${symbol} OR ${mintAddress}) -is:retweet`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=30&tweet.fields=created_at,author_id,public_metrics`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.twitterBearerToken}` }
    });

    if (!response.ok) {
      logger.warn("SOCIAL", "SocialEvaluator", `twitter search HTTP ${response.status} for ${symbol}`);
      return { tweetVolume: 0, recentTweets: [], queried: true };
    }

    const data = await response.json();
    const tweets = data.data || [];
    return {
      tweetVolume: tweets.length,
      recentTweets: tweets.map((t: any) => t.text),
      queried: true
    };
  }

  private analyzeTweetQuality(tweets: string[], queried: boolean): { botScore: number; cashtagSpamRatio: number } {
    if (tweets.length === 0) return { botScore: queried ? 0.0 : -1.0, cashtagSpamRatio: 0.0 };

    let duplicateCount = 0;
    let cashtagSpamCount = 0;
    const seenSnippets = new Set<string>();

    for (const text of tweets) {
      const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
      if (seenSnippets.has(normalized)) duplicateCount++;
      else seenSnippets.add(normalized);

      const cashtags = (text.match(/\$[A-Za-z]+/g) || []).length;
      if (cashtags > 4) cashtagSpamCount++;
    }

    return {
      botScore: Math.min(1.0, duplicateCount / tweets.length),
      cashtagSpamRatio: cashtagSpamCount / tweets.length
    };
  }
}

export const socialEvaluatorService = new SocialEvaluatorService();
