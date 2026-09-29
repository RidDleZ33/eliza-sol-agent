import { getTwitterBearerToken } from "../utils/env.ts";
import { getBirdeyeApiKey } from "../utils/env.ts";
import { getSocialBirdeyeLinks } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

export interface SocialTelemetry {
  mintAddress: string;
  symbol: string;
  hasSocialLinks: boolean;
  socialPlatforms: string[];
  twitterUrl?: string;
  telegramUrl?: string;
  websiteUrl?: string;
  discordUrl?: string;
  isDexBoosted: boolean;
  buySellRatio5m: number;
  txAcceleration5mVs1h: number;
  tweetVolume1h: number;
  twitterQueried: boolean;
  botLikelihoodScore: number;
  cashtagSpamRatio: number;
  rawTextSamples: string[];
  dexMiss: boolean | undefined;
  pumpFunCommentCount?: number;
}

interface LinkCacheEntry {
  links: { platforms: string[]; twitterUrl?: string; telegramUrl?: string; websiteUrl?: string; discordUrl?: string; pair?: any };
  ts: number;
}

const LINK_CACHE_TTL_MS = 30 * 60 * 1000;

export class SocialEvaluatorService {
  private twitterBearerToken: string | undefined;
  private birdeyeApiKey: string | undefined;
  private noBearerLogged = false;
  private linkCache = new Map<string, LinkCacheEntry>();
  // Phase 8F: Twitter 429 cooldown — stop hammering X after rate limit
  private twitterCooldownUntil = 0;
  private twitterCooldownLogged = false;

  constructor() {
    this.twitterBearerToken = getTwitterBearerToken();
    this.birdeyeApiKey = getBirdeyeApiKey();
  }

  private pruneCache() {
    const now = Date.now();
    for (const [mint, entry] of this.linkCache) {
      if (now - entry.ts > LINK_CACHE_TTL_MS) {
        this.linkCache.delete(mint);
      }
    }
  }

  private getCachedLinks(mintAddress: string) {
    this.pruneCache();
    const entry = this.linkCache.get(mintAddress);
    if (entry) {
      return entry.links;
    }
    return null;
  }

  private setCachedLinks(mintAddress: string, links: LinkCacheEntry["links"]) {
    this.linkCache.set(mintAddress, { links, ts: Date.now() });
  }

  private normalizeUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    return url.replace(/\/$/, "");
  }

  private classifyUrl(url: string): string | null {
    const lower = url.toLowerCase();
    if (lower.includes("twitter.com") || lower.includes("x.com")) return "twitter";
    if (lower.includes("t.me")) return "telegram";
    if (lower.includes("discord.gg") || lower.includes("discord.com")) return "discord";
    return "website";
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
      dexMiss: undefined as boolean | undefined,
    };

    // First try cache for links
    const cachedLinks = this.getCachedLinks(mintAddress);
    let sourceTag = "cache";
    if (cachedLinks) {
      telemetry.hasSocialLinks = cachedLinks.platforms.length > 0;
      telemetry.socialPlatforms = cachedLinks.platforms;
      telemetry.twitterUrl = cachedLinks.twitterUrl;
      telemetry.telegramUrl = cachedLinks.telegramUrl;
      telemetry.websiteUrl = cachedLinks.websiteUrl;
      telemetry.discordUrl = cachedLinks.discordUrl;
      // Phase 8F: if we cached the pair, extract metrics from it
      if (cachedLinks.pair) {
        const metrics = this.extractDexMetrics(cachedLinks.pair);
        if (metrics) Object.assign(telemetry, metrics);
      }
    } else {
      // Fetch fresh links from Dex pair + optionally Birdeye overview
      const tasks = [this.fetchDexPairLinks(mintAddress)];
      if (getSocialBirdeyeLinks() && this.birdeyeApiKey) {
        tasks.push(this.fetchBirdeyeOverviewLinks(mintAddress));
      } else {
        logger.debug("SOCIAL", "SocialEvaluator", "birdeye social links skip: flag off");
      }

      const results = await Promise.allSettled(tasks);
      const dexLinks = results[0];
      const birdeyeLinks = tasks.length > 1 ? results[1] : null;

      const allPlatforms = new Set<string>();
      let twitterUrl: string | undefined;
      let telegramUrl: string | undefined;
      let websiteUrl: string | undefined;
      let discordUrl: string | undefined;

      if (dexLinks.status === "fulfilled" && dexLinks.value) {
        const l = dexLinks.value;
        l.platforms.forEach(p => allPlatforms.add(p));
        if (l.twitterUrl && !twitterUrl) twitterUrl = l.twitterUrl;
        if (l.telegramUrl && !telegramUrl) telegramUrl = l.telegramUrl;
        if (l.websiteUrl && !websiteUrl) websiteUrl = l.websiteUrl;
        if (l.discordUrl && !discordUrl) discordUrl = l.discordUrl;
        // Phase 8F: reuse Dex body for metrics
        const metrics = this.extractDexMetrics(l.pair);
        if (metrics) Object.assign(telemetry, metrics);
      }

      if (birdeyeLinks && birdeyeLinks.status === "fulfilled" && birdeyeLinks.value) {
        const l = birdeyeLinks.value;
        l.platforms.forEach(p => allPlatforms.add(p));
        if (l.twitterUrl && !twitterUrl) twitterUrl = l.twitterUrl;
        if (l.telegramUrl && !telegramUrl) telegramUrl = l.telegramUrl;
        if (l.websiteUrl && !websiteUrl) websiteUrl = l.websiteUrl;
        if (l.discordUrl && !discordUrl) discordUrl = l.discordUrl;
      }

      const platforms = Array.from(allPlatforms);
      if (dexLinks.status === "fulfilled" && dexLinks.value && birdeyeLinks && birdeyeLinks.status === "fulfilled" && birdeyeLinks.value) {
        sourceTag = "dex|birdeye";
      } else if (dexLinks.status === "fulfilled" && dexLinks.value) {
        sourceTag = "dex";
      } else if (birdeyeLinks && birdeyeLinks.status === "fulfilled" && birdeyeLinks.value) {
        sourceTag = "birdeye";
      } else {
        sourceTag = "none";
      }

      telemetry.hasSocialLinks = platforms.length > 0;
      telemetry.socialPlatforms = platforms;
      telemetry.twitterUrl = twitterUrl;
      telemetry.telegramUrl = telegramUrl;
      telemetry.websiteUrl = websiteUrl;
      telemetry.discordUrl = discordUrl;

      // Phase 8F: cache the pair so metrics can be re-extracted without a new HTTP call
      const cachedPair = (dexLinks.status === "fulfilled" && dexLinks.value) ? dexLinks.value.pair : null;
      this.setCachedLinks(mintAddress, { platforms, twitterUrl, telegramUrl, websiteUrl, discordUrl, pair: cachedPair });
    }

    // Twitter is optional, only if bearer exists
    if (this.twitterBearerToken) {
      const twitterData = await this.fetchTwitterData(symbol, mintAddress);
      telemetry.tweetVolume1h = twitterData.tweetVolume;
      telemetry.twitterQueried = twitterData.queried;
      telemetry.rawTextSamples = twitterData.recentTweets;

      const metrics = this.analyzeTweetQuality(twitterData.recentTweets, twitterData.queried);
      telemetry.botLikelihoodScore = metrics.botScore;
      telemetry.cashtagSpamRatio = metrics.cashtagSpamRatio;
    } else {
      if (!this.noBearerLogged) {
        logger.info("SOCIAL", "SocialEvaluator", "twitter skip: NO_BEARER");
        this.noBearerLogged = true;
      }
    }

    logger.info("SOCIAL", "SocialEvaluator", `social links source=${sourceTag} platforms=${telemetry.socialPlatforms.join(",") || "none"}`);

    return telemetry;
  }

  private async fetchDexPairLinks(mintAddress: string) {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const pair = data?.pairs?.[0];
    if (!pair) {
      return null;
    }

    const platforms: string[] = [];
    let twitterUrl: string | undefined;
    let telegramUrl: string | undefined;
    let websiteUrl: string | undefined;
    let discordUrl: string | undefined;

    for (const s of pair.info?.socials || []) {
      const type = this.classifyUrl(s.url);
      if (type) {
        platforms.push(type);
        if (type === "twitter" && !twitterUrl) twitterUrl = this.normalizeUrl(s.url);
        if (type === "telegram" && !telegramUrl) telegramUrl = this.normalizeUrl(s.url);
        if (type === "discord" && !discordUrl) discordUrl = this.normalizeUrl(s.url);
      }
    }

    for (const w of pair.info?.websites || []) {
      const type = this.classifyUrl(w.url);
      if (type && type === "website" && !websiteUrl) {
        platforms.push("website");
        websiteUrl = this.normalizeUrl(w.url);
      }
    }

    if (platforms.length === 0) {
      return null;
    }

    return { platforms, twitterUrl, telegramUrl, websiteUrl, discordUrl, pair };
  }

  private extractDexMetrics(pair: any) {
    if (!pair) return null;
    const txs = pair.txns || pair.txs || {};
    const buys5m = txs.m5?.buys || 0;
    const sells5m = txs.m5?.sells || 0;
    const total1hAvg5m = ((txs.h1?.buys || 0) + (txs.h1?.sells || 0)) / 12;
    return {
      isDexBoosted: (pair.boosts?.active || 0) > 0,
      buySellRatio5m: sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2.0 : 1.0,
      txAcceleration5mVs1h: total1hAvg5m > 0 ? (buys5m + sells5m) / total1hAvg5m : 1.0,
      dexMiss: false
    };
  }

  private async fetchBirdeyeOverviewLinks(mintAddress: string) {
    if (!this.birdeyeApiKey) {
      return null;
    }

    const url = `https://public-api.birdeye.so/defi/token_overview?address=${mintAddress}`;
    const headers = {
      "x-chain": "solana",
      "X-API-KEY": this.birdeyeApiKey,
      "accept": "application/json",
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.success === false) {
      return null;
    }

    const platforms: string[] = [];
    let twitterUrl: string | undefined;
    let telegramUrl: string | undefined;
    let websiteUrl: string | undefined;
    let discordUrl: string | undefined;

    const tokenInfo = data.data;
    if (!tokenInfo) return null;

    // Birdeye puts social in various places depending on version
    // Check extensions first
    const extensions = tokenInfo.extensions || {};
    if (extensions.twitter) {
      const type = this.classifyUrl(extensions.twitter);
      if (type === "twitter") {
        platforms.push(type);
        twitterUrl = this.normalizeUrl(extensions.twitter);
      }
    }
    if (extensions.telegram) {
      const type = this.classifyUrl(extensions.telegram);
      if (type === "telegram") {
        platforms.push(type);
        telegramUrl = this.normalizeUrl(extensions.telegram);
      }
    }
    if (extensions.website) {
      const type = this.classifyUrl(extensions.website);
      if (type === "website") {
        platforms.push(type);
        websiteUrl = this.normalizeUrl(extensions.website);
      }
    }
    if (extensions.discord) {
      const type = this.classifyUrl(extensions.discord);
      if (type === "discord") {
        platforms.push(type);
        discordUrl = this.normalizeUrl(extensions.discord);
      }
    }

    // Check token socials array
    for (const s of tokenInfo.socials || []) {
      const type = this.classifyUrl(s.url);
      if (type) {
        platforms.push(type);
        if (type === "twitter" && !twitterUrl) twitterUrl = this.normalizeUrl(s.url);
        if (type === "telegram" && !telegramUrl) telegramUrl = this.normalizeUrl(s.url);
        if (type === "website" && !websiteUrl) websiteUrl = this.normalizeUrl(s.url);
        if (type === "discord" && !discordUrl) discordUrl = this.normalizeUrl(s.url);
      }
    }

    if (platforms.length === 0) {
      return null;
    }

    return { platforms, twitterUrl, telegramUrl, websiteUrl, discordUrl };
  }

  private async fetchDexScreenerMetrics(mintAddress: string) {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const pair = data?.pairs?.[0];
      if (!pair) {
        return null;
      }

      const txs = pair.txns || pair.txs || {};
      const buys5m = txs.m5?.buys || 0;
      const sells5m = txs.m5?.sells || 0;
      const total1hAvg5m = ((txs.h1?.buys || 0) + (txs.h1?.sells || 0)) / 12;

      return {
        isDexBoosted: (pair.boosts?.active || 0) > 0,
        buySellRatio5m: sells5m > 0 ? buys5m / sells5m : buys5m > 0 ? 2.0 : 1.0,
        txAcceleration5mVs1h: total1hAvg5m > 0 ? (buys5m + sells5m) / total1hAvg5m : 1.0,
        dexMiss: false
      };
    } catch (e) {
      logger.warn("SOCIAL", "SocialEvaluator", "dex metrics fetch failed", { error: e });
      return null;
    }
  }

  private async fetchTwitterData(symbol: string, mintAddress: string) {
    if (!this.twitterBearerToken) {
      return { tweetVolume: 0, recentTweets: [], queried: false };
    }

    // Phase 8F: check 429 cooldown
    if (Date.now() < this.twitterCooldownUntil) {
      if (!this.twitterCooldownLogged) {
        logger.warn("SOCIAL", "SocialEvaluator", "twitter 429 cooldown active, skipping query");
        this.twitterCooldownLogged = true;
      }
      // queried=false so 8C social-unknown path is not fooled into thinking X was queried
      return { tweetVolume: 0, recentTweets: [], queried: false };
    }

    const query = encodeURIComponent(`($${symbol} OR ${mintAddress}) -is:retweet`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=30&tweet.fields=created_at,author_id,public_metrics`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.twitterBearerToken}` }
    });

    if (response.status === 429) {
      // Phase 8F: 15-minute cooldown, log once
      this.twitterCooldownUntil = Date.now() + 15 * 60 * 1000;
      this.twitterCooldownLogged = false;
      logger.warn("SOCIAL", "SocialEvaluator", "twitter 429 rate limited, cooling down 15min");
      return { tweetVolume: 0, recentTweets: [], queried: false };
    }

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