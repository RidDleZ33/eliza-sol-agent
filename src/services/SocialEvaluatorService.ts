import { getTwitterBearerToken } from "../utils/env.ts";

export interface SocialTelemetry {
  mintAddress: string;
  symbol: string;
  tweetVolume1h?: number;
  hasSocialLinks: boolean;
  buySellRatio5m: number;
  rawTextSamples: string[];
}

export class SocialEvaluatorService {
  private twitterBearerToken: string | undefined;

  constructor() {
    this.twitterBearerToken = getTwitterBearerToken();
  }

  async evaluateToken(mintAddress: string, symbol: string): Promise<SocialTelemetry> {
    let telemetry: SocialTelemetry = {
      mintAddress,
      symbol,
      hasSocialLinks: false,
      buySellRatio5m: 1.0,
      rawTextSamples: []
    };

    try {
      // Fetch DexScreener data
      const dexData = await this.fetchDexScreenerData(mintAddress);
      telemetry.hasSocialLinks = dexData.hasSocialLinks;
      telemetry.buySellRatio5m = dexData.buySellRatio5m;
    } catch (e) {
      console.log(`[SocialEvaluator] DexScreener fetch failed for ${symbol}:`, e.message);
    }

    try {
      // Fetch Twitter data if API key available
      if (this.twitterBearerToken) {
        const twitterData = await this.fetchTwitterData(symbol);
        telemetry.tweetVolume1h = twitterData.tweetVolume;
        telemetry.rawTextSamples = twitterData.recentTweets;
      }
    } catch (e) {
      console.log(`[SocialEvaluator] Twitter fetch failed for ${symbol}:`, e.message);
    }

    return telemetry;
  }

  private async fetchDexScreenerData(mintAddress: string) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`DexScreener API returned ${response.status}`);
    }

    const data = await response.json();
    const pair = data?.pair?.[0];

    if (!pair) {
      throw new Error("No pair data found");
    }

    const socialLinks = pair.info?.socials || [];
    const hasSocialLinks = socialLinks.length > 0;

    // Calculate buy/sell ratio from txs
    const txs = pair.txs || {};
    const buys5m = txs.buys?.m5 || 0;
    const sells5m = txs.sells?.m5 || 0;
    const buySellRatio5m = sells5m > 0 ? buys5m / sells5m : (buys5m > 0 ? 2.0 : 1.0);

    return { hasSocialLinks, buySellRatio5m };
  }

  private async fetchTwitterData(symbol: string) {
    // Twitter API v2 search
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${symbol}%20-mock&max_results=10`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.twitterBearerToken}`,
        "User-Agent": "AICommittee/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Twitter API returned ${response.status}`);
    }

    const data = await response.json();
    const tweets = data.data || [];

    return {
      tweetVolume: tweets.length,
      recentTweets: tweets.slice(0, 5).map((t: any) => t.text)
    };
  }
}

export const socialEvaluatorService = new SocialEvaluatorService();
export default socialEvaluatorService;