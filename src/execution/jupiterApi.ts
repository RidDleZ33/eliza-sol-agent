// Phase 1B: Jupiter v6 HTTP API (quote-api.jup.ag deprecated).
// Primary host: lite-api.jup.ag (public, no key required).
// Fallback host: api.jup.ag (may require JUPITER_API_KEY header).
// Docs: https://docs.jup.ag/api-reference/swap-api/get-quote

import { logger } from "../services/LoggerService.ts";
import { env } from "../utils/env.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_TIMEOUT_MS = 10_000;
const SWAP_TIMEOUT_MS = 15_000;

// Slim quote type (backwards-compatible with phase 1A)
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  otherAmountThreshold: string;
}

// Full quote result: slim shape for convenience + raw for swap POST
export interface JupiterQuoteResult {
  slim: JupiterQuote;
  raw: unknown; // entire response JSON, needed by /swap/v1/swap
}

interface SwapBuildInput {
  quoteResponse: unknown;
  userPublicKey: string;
}

interface SwapBuildResult {
  swapTransaction: string; // base64
}

let quoteHost = "https://lite-api.jup.ag";
let quoteHostVerified = false;

function getSwapHost(): string {
  // Swap endpoint uses the same host as quote
  return quoteHost;
}

async function verifyQuoteHost(): Promise<void> {
  if (quoteHostVerified) return;
  quoteHostVerified = true;
  logger.info("EXECUTION", "jupiterApi", "Verifying quote host", { host: quoteHost });

  try {
    const testUrl = `${quoteHost}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${SOL_MINT}&amount=1000000000&slippageBps=50`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
    const res = await fetch(testUrl, { signal: ctrl.signal });
    clearTimeout(timer);

    if (res.ok || res.status === 400) {
      logger.info("EXECUTION", "jupiterApi", "Quote host verified", { host: quoteHost });
    } else if (res.status === 404) {
      // lite-api 404 → try api.jup.ag (may need key)
      logger.warn("EXECUTION", "jupiterApi", "lite-api returned 404, trying api.jup.ag");
      quoteHost = "https://api.jup.ag";
      logger.info("EXECUTION", "jupiterApi", "Switched quote host", { host: quoteHost });
    } else {
      logger.warn("EXECUTION", "jupiterApi", "Unexpected status from quote host", { status: res.status, host: quoteHost });
    }
  } catch (e: any) {
    logger.warn("EXECUTION", "jupiterApi", "Quote host verification failed, trying api.jup.ag", {
      error: e?.message,
      host: quoteHost,
    });
    quoteHost = "https://api.jup.ag";
  }
}

export async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps: number
): Promise<JupiterQuoteResult | null> {
  await verifyQuoteHost();

  const url = `${quoteHost}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn("EXECUTION", "jupiterQuote", "HTTP error", { status: res.status, url });
      return null;
    }
    const raw = await res.json();

    // Validate required fields
    if (!raw.inAmount || !raw.outAmount) {
      logger.warn("EXECUTION", "jupiterQuote", "Quote missing inAmount/outAmount", { raw });
      return null;
    }

    const slim: JupiterQuote = {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmount: raw.inAmount,
      outAmount: raw.outAmount,
      priceImpactPct: raw.priceImpactPct || "0",
      otherAmountThreshold: raw.otherAmountThreshold || raw.outAmount,
    };

    return { slim, raw };
  } catch (e: any) {
    logger.warn("EXECUTION", "jupiterQuote", "Failed", { error: e?.message, url });
    return null;
  }
}

/**
 * Phase 1B: Build swap transaction via /swap/v1/swap.
 * Returns base64-encoded transaction, or null on failure.
 */
export async function jupiterBuildSwap(
  quoteResponse: unknown,
  userPublicKey: string
): Promise<string | null> {
  const url = `${getSwapHost()}/swap/v1/swap`;
  const body: SwapBuildInput = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // api.jup.ag requires key; lite-api does not
    const apiKey = env.JUPITER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SWAP_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      logger.warn("EXECUTION", "jupiterBuildSwap", "HTTP error", {
        status: res.status,
        url,
        body: text,
      });
      return null;
    }

    const data: SwapBuildResult = await res.json();
    if (!data.swapTransaction) {
      logger.warn("EXECUTION", "jupiterBuildSwap", "Response missing swapTransaction", { data });
      return null;
    }
    return data.swapTransaction;
  } catch (e: any) {
    logger.warn("EXECUTION", "jupiterBuildSwap", "Failed", { error: e?.message, url });
    return null;
  }
}
