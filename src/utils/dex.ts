import {
  computeUnitPrice,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getQuote } from "@elizaos/plugin-jupiter";
import { env, isDryRun } from "./env.ts";
import { logger } from "../services/LoggerService.ts";

export async function executeSwap(params: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: number;
  slippageBps: number;
  owner: PublicKey;
}): Promise<{ success: boolean; txId?: string; error?: string }> {
  if (isDryRun()) {
    logger.info("DEX", "swapTokens", "[DRY RUN] swap", { amountIn: params.amountIn, inputMint: params.inputMint.toBase58(), outputMint: params.outputMint.toBase58() });
    return { success: true, txId: "dry-run-tx" };
  }

  try {
    const quote = await getQuote(params);
    // Jito routing via plugin-jupiter handles MEV protection
    const { tx } = await quote.executeSwap();
    return { success: true, txId: tx };
  } catch (e: any) {
    logger.error("DEX", "swapTokens", "Swap execution failed", { error: e.message });
    return { success: false, error: e.message };
  }
}
