// GMGN OpenAPI kline OHLCV fetcher for Gamma PA.
// Endpoint: https://openapi.gmgn.ai/v1/market/token_kline
// Auth: X-APIKEY header (GMGN_API_KEY), optional
// Query: chain, address, resolution, from, to (ms), timestamp (s), client_id (uuid)
// Response: { data: [ [ts, open, high, low, close, volume], ... ] } or object form
// Returns null bars on failure — never throws. No retry loop.

import { OhlcvBar } from "./candleFeatures.ts";
import { logger } from "../LoggerService.ts";
import { getGmgnApiKey } from "../../utils/env.ts";

export type GmgnOhlcvResult =
  | { bars: OhlcvBar[]; reason: string }
  | { bars: null; reason: string };

// 2 req/sec pacing — skip if called within 500ms of the last request
let lastRequestTime = 0;

export async function fetchGmgnOhlcv(
  mint: string,
  resolution: "1m" | "5m" = "1m",
  countLimit: number = 60
): Promise<GmgnOhlcvResult> {
  const nowMs = Date.now();

  // Pace: if called within 500ms of the last request, skip and fall through
  if (nowMs - lastRequestTime < 500) {
    return { bars: null, reason: "paced" };
  }

  const apiKey = getGmgnApiKey();

  const barSecs = resolution === "1m" ? 60 : 300;
  const to = nowMs;
  const from = nowMs - countLimit * barSecs * 1000;
  const timestampSecs = Math.floor(nowMs / 1000);

  // Generate client_id uuid
  let clientId = "";
  try {
    const { v4: uuidv4 } = await import("@stdlib/uuid");
    clientId = uuidv4();
  } catch {
    clientId = `${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  const url = new URL("https://openapi.gmgn.ai/v1/market/token_kline");
  url.searchParams.set("chain", "sol");
  url.searchParams.set("address", mint);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("timestamp", String(timestampSecs));
  url.searchParams.set("client_id", clientId);

  lastRequestTime = nowMs;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers["X-APIKEY"] = apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 300).replace(/\n/g, " ").trim();
      if (response.status === 429) {
        logger.info(`PA gmgn 429 mint=${mint} body=${snippet}`);
      } else {
        logger.info(`PA gmgn http error mint=${mint} status=${response.status} body=${snippet}`);
      }
      return { bars: null, reason: `http_${response.status}` };
    }

    const body = await response.json();
    let candles = body?.data;
    // data may be an object with a list array
    if (candles && typeof candles === "object" && Array.isArray(candles.list)) {
      candles = candles.list;
    }
    if (!Array.isArray(candles) || candles.length === 0) {
      const raw = JSON.stringify(body).slice(0, 200);
      logger.info("PA gmgn no candles", { mint, reason: "empty_data", body: raw });
      return { bars: null, reason: "empty_data" };
    }

    // Map candles to OhlcvBar — accept both array [ts,o,h,l,c,v] and object form
    const bars: OhlcvBar[] = [];
    for (const c of candles) {
      if (Array.isArray(c) && c.length >= 6) {
        // Array form [ts, open, high, low, close, volume]
        let ts = Number(c[0]);
        if (ts < 1000000000000) ts = ts * 1000; // seconds to ms (< 1e12)
        const o = Number(c[1]);
        const h = Number(c[2]);
        const l = Number(c[3]);
        const cl = Number(c[4]);
        const v = Number(c[5]);
        if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
        bars.push({ t: ts, o, h, l, c: cl, v: Number.isFinite(v) ? v : 0 });
      } else if (c && typeof c === "object") {
        // Object form with ts/timestamp, open, high, low, close, volume
        let ts = Number(c.ts ?? c.timestamp ?? 0);
        if (ts < 1000000000000) ts = ts * 1000; // seconds to ms (< 1e12)
        const o = Number(c.open);
        const h = Number(c.high);
        const l = Number(c.low);
        const cl = Number(c.close);
        const v = Number(c.volume ?? 0);
        if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
        bars.push({ t: ts, o, h, l, c: cl, v: Number.isFinite(v) ? v : 0 });
      }
    }

    if (bars.length === 0) {
      return { bars: null, reason: "all_non_finite" };
    }

    bars.sort((a, b) => a.t - b.t);
    return { bars, reason: "ok" };
  } catch (e: any) {
    logger.info("PA gmgn fetch error", { mint, reason: e.message ?? "unknown" });
    return { bars: null, reason: e.message ?? "fetch_error" };
  }
}

export default fetchGmgnOhlcv;
