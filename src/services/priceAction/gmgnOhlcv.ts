// GMGN kline OHLCV fetcher for Gamma PA (fallback-free, no API key).
// Endpoint: https://www.gmgn.cc/defi/quotation/v1/tokens/kline/sol/{mint}
// Body: { data: [ [ts, open, high, low, close, volume], ... ] }
// Returns null bars on failure — never throws. No retry loop.

import { OhlcvBar } from "./candleFeatures.ts";
import { logger } from "../LoggerService.ts";

export type GmgnOhlcvResult =
  | { bars: OhlcvBar[]; reason: string }
  | { bars: null; reason: string };

export async function fetchGmgnOhlcv(
  mint: string,
  resolution: "1m" | "5m" = "1m",
  countLimit: number = 60
): Promise<GmgnOhlcvResult> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const barSecs = resolution === "1m" ? 60 : 300;
  const to = nowSecs;
  const from = nowSecs - countLimit * barSecs;
  const url = `https://www.gmgn.cc/defi/quotation/v1/tokens/kline/sol/${mint}?resolution=${resolution}&from=${from}&to=${to}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Referer: url,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 403) {
      logger.info("PA gmgn http error", { mint, status: 403, body: "cloudflare 403" });
      return { bars: null, reason: "http_403" };
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 200).replace(/\n/g, " ");
      logger.info("PA gmgn http error", { mint, status: response.status, body: snippet });
      return { bars: null, reason: `http_${response.status}` };
    }

    const body = await response.json();
    const candles = body?.data;
    if (!Array.isArray(candles) || candles.length === 0) {
      logger.info("PA gmgn no candles", { mint, reason: "empty_data" });
      return { bars: null, reason: "empty_data" };
    }

    // Map kline arrays [ts, open, high, low, close, volume] to OhlcvBar
    const bars: OhlcvBar[] = [];
    for (const c of candles) {
      if (!Array.isArray(c) || c.length < 6) continue;
      const ts = Number(c[0]);
      const o = Number(c[1]);
      const h = Number(c[2]);
      const l = Number(c[3]);
      const cl = Number(c[4]);
      const v = Number(c[5]);
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
      bars.push({ t: ts * 1000, o, h, l, c: cl, v: Number.isFinite(v) ? v : 0 });
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
