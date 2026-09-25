// Normalize DexScreener pair data into market_ticks columns.
// DexScreener's /latest/dex/tokens/{mints} returns array of { chainId, pairAddress, ... }
// token-profiles/latest returns array of { chain, pairAddress, ... } (different shape)

const { createHash } = require("crypto");

// Bun-compatible sha256 wrapper
function sha256hex(data: string): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

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
  const price = pair.priceUsd;
  const priceNative = pair.priceNative;

  // Compute price_native if only priceUsd available
  let effectivePriceNative = parseNum(priceNative);
  if (effectivePriceNative === null && parseNum(price) !== null && quoteToken.symbol === "SOL") {
    // We'll let sol_usd handle this later; store null for now
  }

  const socials: any = {};
  if (pair.info?.websites?.length) socials.website = pair.info.websites[0].url;
  if (pair.info?.socials?.length) {
    for (const s of pair.info.socials) {
      if (s.type === "twitter") socials.twitter = s.url;
      else if (s.type === "telegram") socials.telegram = s.url;
    }
  }
  const hasSocials = Object.keys(socials).length > 0 ? 1 : 0;

  const raw = JSON.stringify(pair);
  const sha = sha256hex(raw);

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
    price_usd: parseNum(price),
    price_native: effectivePriceNative,
    liq_usd: parseNum(pair.liquidity?.usd),
    liq_base: parseNum(pair.liquidity?.base),
    liq_quote: parseNum(pair.liquidity?.quote),
    fdv_usd: parseNum(pair.fdv),
    mcap_usd: parseNum(pair.marketCap),
    vol_5m_usd: parseNum(pair.volume?.m5?.usd),
    vol_1h_usd: parseNum(pair.volume?.h1?.usd),
    vol_6h_usd: parseNum(pair.volume?.h6?.usd),
    vol_24h_usd: parseNum(pair.volume?.h24?.usd),
    tx_5m_buys: parseInteger(pair.volume?.m5?.buys),
    tx_5m_sells: parseInteger(pair.volume?.m5?.sells),
    tx_1h_buys: parseInteger(pair.volume?.h1?.buys),
    tx_1h_sells: parseInteger(pair.volume?.h1?.sells),
    tx_24h_buys: parseInteger(pair.volume?.h24?.buys),
    tx_24h_sells: parseInteger(pair.volume?.h24?.sells),
    change_5m_pct: parseNum(pair.priceChange?.m5),
    change_1h_pct: parseNum(pair.priceChange?.h1),
    change_6h_pct: parseNum(pair.priceChange?.h6),
    change_24h_pct: parseNum(pair.priceChange?.h24),
    pair_created_at: pair.createdAt ? new Date(pair.createdAt).toISOString() : null,
    pair_created_at_ms: pair.createdAt ? pair.createdAt : null,
    boost_active: pair.isBoosted ? 1 : 0,
    has_socials: hasSocials,
    socials_json: hasSocials ? JSON.stringify(socials) : null,
    universe_hint: null,
    raw_json: raw,
    raw_sha256: sha,
  };
}
