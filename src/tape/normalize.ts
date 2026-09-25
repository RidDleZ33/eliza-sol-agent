// Normalize DexScreener pair data into market_ticks columns.
// DexScreener pair shape:
// - volume.m5 = number (USD volume), not volume.m5.usd
// - txns.m5.buys / txns.m5.sells, not volume.m5.buys
// - pairCreatedAt = ms, not createdAt
// - boosts.active, not isBoosted

import { createHash } from "crypto";

interface TickFields {
  source: string;
  source_endpoint: string;
  chain_id: string;
  mint: string;
  quote_mint: string | null;
  pair_address: string;
  dex_id: string | null;
  symbol: string | null;
  name: string | null;
  price_usd: number | null;
  price_native: number | null;
  liq_usd: number | null;
  liq_base: number | null;
  liq_quote: number | null;
  fdv_usd: number | null;
  mcap_usd: number | null;
  vol_5m_usd: number | null;
  vol_1h_usd: number | null;
  vol_6h_usd: number | null;
  vol_24h_usd: number | null;
  tx_5m_buys: number | null;
  tx_5m_sells: number | null;
  tx_1h_buys: number | null;
  tx_1h_sells: number | null;
  tx_24h_buys: number | null;
  tx_24h_sells: number | null;
  change_5m_pct: number | null;
  change_1h_pct: number | null;
  change_6h_pct: number | null;
  change_24h_pct: number | null;
  pair_created_at: string | null;
  pair_created_at_ms: number | null;
  boost_active: number;
  has_socials: number;
  socials_json: string | null;
  universe_hint: string | null;
  raw_json: string;
  raw_sha256: string;
}

function parseNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function parseInteger(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : null;
}

export function normalizeDexScreenerPair(pair: any, sourceEndpoint: string): TickFields {
  const baseToken = pair.baseToken || {};
  const quoteToken = pair.quoteToken || {};

  const raw = JSON.stringify(pair);
  const sha = createHash("sha256").update(raw).digest("hex");

  return {
    source: "dexscreener",
    source_endpoint: sourceEndpoint,
    chain_id: pair.chainId || "solana",
    mint: baseToken.address,
    quote_mint: quoteToken.address || null,
    pair_address: pair.pairAddress,
    dex_id: pair.dexId || null,
    symbol: pair.pairName ? pair.pairName.split("-")[0] : baseToken.symbol || null,
    name: baseToken.name || null,
    price_usd: parseNum(pair.priceUsd),
    price_native: parseNum(pair.priceNative),
    liq_usd: parseNum(pair.liquidity?.usd),
    liq_base: parseNum(pair.liquidity?.base),
    liq_quote: parseNum(pair.liquidity?.quote),
    fdv_usd: parseNum(pair.fdv),
    mcap_usd: parseNum(pair.marketCap),
    // volume fields are direct numbers (USD), not nested .usd
    vol_5m_usd: parseNum(pair.volume?.m5),
    vol_1h_usd: parseNum(pair.volume?.h1),
    vol_6h_usd: parseNum(pair.volume?.h6),
    vol_24h_usd: parseNum(pair.volume?.h24),
    // txns are under pair.txns, not pair.volume
    tx_5m_buys: parseInteger(pair.txns?.m5?.buys),
    tx_5m_sells: parseInteger(pair.txns?.m5?.sells),
    tx_1h_buys: parseInteger(pair.txns?.h1?.buys),
    tx_1h_sells: parseInteger(pair.txns?.h1?.sells),
    tx_24h_buys: parseInteger(pair.txns?.h24?.buys),
    tx_24h_sells: parseInteger(pair.txns?.h24?.sells),
    change_5m_pct: parseNum(pair.priceChange?.m5),
    change_1h_pct: parseNum(pair.priceChange?.h1),
    change_6h_pct: parseNum(pair.priceChange?.h6),
    change_24h_pct: parseNum(pair.priceChange?.h24),
    // pairCreatedAt is ms, not createdAt
    pair_created_at: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    pair_created_at_ms: pair.pairCreatedAt ? pair.pairCreatedAt : null,
    // boosts.active, not isBoosted
    boost_active: pair.boosts?.active ? 1 : 0,
    has_socials: 0, // v1: not extracting socials from pair
    socials_json: null,
    universe_hint: null,
    raw_json: raw,
    raw_sha256: sha,
  };
}
