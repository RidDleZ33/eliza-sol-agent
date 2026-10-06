// Birdeye OHLCV fetcher for Gamma PA (60x1m per mint / 90s TTL).
// Returns null bars on failure — never throws. ~12 CU when items <= 100.

import { OhlcvBar } from "./candleFeatures.ts";
import { logger } from "../LoggerService.ts";

export type BirdeyeOhlcvResult =
  | { bars: OhlcvBar[]; reason: string }
  | { bars: null; reason: string };

export interface BirdeyeOhlcvItem {
  unix_time?: number;
  unixTime?: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  v_usd?: number;
}

export interface BirdeyeOhlcvResponse {
  success: boolean;
  data:
    | { items: BirdeyeOhlcvItem[] }
    | BirdeyeOhlcvItem[]
    | null;
  message?: string;
}

export async function fetchBirdeyeOhlcv(
  mint: string,
  apiKey: string,
  interval: "1m" | "5m" = "1m",
  countLimit: number = 60
): Promise<BirdeyeOhlcvResult> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const url =
    "https://public-api.birdeye.so/defi/v3/ohlcv" +
    "?address=" + encodeURIComponent(mint) +
    `&type=${interval}&mode=count&count_limit=${countLimit}&time_to=` + nowSecs;

  try {
    const response = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": "solana",
        accept: "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      return { bars: null, reason: `auth_${response.status}` };
    }
    if (response.status === 429) {
      return { bars: null, reason: "rate_429" };
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 200).replace(/\n/g, " ");
      logger(`[birdeye-ohlcv] ${mint} http_${response.status} ${snippet}`);
      return { bars: null, reason: `http_${response.status}` };
    }

    const body: BirdeyeOhlcvResponse = await response.json();
    if (body.success === false) {
      return {
        bars: null,
        reason: body.message ?? "success_false",
      };
    }

    // Body shape: { success: true, data: { items: [...] } } or { success: true, data: [...] }
    const items = parseOhlcvItems(body.data);
    if (!items || items.length === 0) {
      return { bars: null, reason: "empty_items" };
    }

    // Map to OhlcvBar (t in epoch ms)
    const bars: OhlcvBar[] = [];
    for (const item of items) {
      if (!Number.isFinite(item.o) || !Number.isFinite(item.h) ||
          !Number.isFinite(item.l) || !Number.isFinite(item.c)) {
        continue;
      }
      const v = Number.isFinite(item.v) ? item.v : (item.v_usd ?? 0);
      // Accept unix_time (snake) or unixTime (camel) from Birdeye
      const raw = item.unix_time ?? item.unixTime;
      if (!Number.isFinite(raw)) continue;
      const t = raw < 1e12 ? raw * 1000 : raw;
      bars.push({ t, o: item.o, h: item.h, l: item.l, c: item.c, v });
    }

    if (bars.length === 0) {
      return { bars: null, reason: "all_non_finite" };
    }

    // Sort ascending by time
    bars.sort((a, b) => a.t - b.t);

    return { bars, reason: "ok" };
  } catch (e: any) {
    return { bars: null, reason: e.message ?? "fetch_error" };
  }
}

function parseOhlcvItems(
  data: BirdeyeOhlcvItem[] | { items: BirdeyeOhlcvItem[] } | null
): BirdeyeOhlcvItem[] | null {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  if (data.items) return data.items;
  return null;
}

export default fetchBirdeyeOhlcv;
