import { logger } from "../services/LoggerService.ts";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_URL = "https://quote-api.jup.ag/v6/quote";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  otherAmountThreshold: string;
}

export async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  slippageBps: number
): Promise<JupiterQuote | null> {
  const url = `${QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn("EXECUTION", "jupiterQuote", "HTTP error", { status: res.status, url });
      return null;
    }
    const data = await res.json();
    return {
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      priceImpactPct: data.priceImpactPct,
      otherAmountThreshold: data.otherAmountThreshold,
    };
  } catch (e: any) {
    logger.warn("EXECUTION", "jupiterQuote", "Failed", { error: e?.message, url });
    return null;
  }
}
