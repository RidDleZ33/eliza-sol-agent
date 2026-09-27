import { Connection, Keypair } from "@solana/web3.js";
import { env } from "./env.ts";
import { logger } from "../services/LoggerService.ts";

export function createConnection(): Connection {
  return new Connection(env.RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 30000,
  });
}

/**
 * Unified house keypair parser (phase 0C).
 *
 * Accepts either:
 *   - SOLANA_PRIVATE_KEY: base64-encoded 64-byte secret key (TradeExecution path)
 *   - GAMMA_PRIVATE_KEY:  JSON array of bytes (former plugin path)
 *
 * Rules:
 *   - Neither set → null (paper/dry-run without a key is allowed)
 *   - One set → parse; throw on parse failure (garbage ≠ unset)
 *   - Both set → parse both; if pubkeys differ, throw. Otherwise return the matching keypair.
 *   - Logs public key once; never logs secret material.
 */
export function getHouseKeypair(): Keypair | null {
  const hasSolana = !!env.SOLANA_PRIVATE_KEY;
  const hasGamma = !!env.GAMMA_PRIVATE_KEY;

  if (!hasSolana && !hasGamma) {
    logger.warn("EXECUTION", "getHouseKeypair", "No private key set; execution disabled");
    return null;
  }

  let solanaKeypair: Keypair | null = null;
  let gammaKeypair: Keypair | null = null;

  if (hasSolana) {
    try {
      const bytes = Buffer.from(env.SOLANA_PRIVATE_KEY!, "base64");
      solanaKeypair = Keypair.fromSecretKey(bytes);
    } catch (e: any) {
      throw new Error(`Failed to parse SOLANA_PRIVATE_KEY (base64): ${e.message}`);
    }
  }

  if (hasGamma) {
    try {
      const keyBytes = Uint8Array.from(JSON.parse(env.GAMMA_PRIVATE_KEY!));
      gammaKeypair = Keypair.fromSecretKey(keyBytes);
    } catch (e: any) {
      throw new Error(`Failed to parse GAMMA_PRIVATE_KEY (JSON): ${e.message}`);
    }
  }

  // Both set — must match
  if (solanaKeypair && gammaKeypair) {
    if (solanaKeypair.publicKey.toBase58() !== gammaKeypair.publicKey.toBase58()) {
      throw new Error(
        "SOLANA_PRIVATE_KEY and GAMMA_PRIVATE_KEY resolve to different public keys; " +
        "set only one or make them identical."
      );
    }
    logger.info("EXECUTION", "getHouseKeypair", "Loaded house keypair", {
      pubkey: solanaKeypair.publicKey.toBase58(),
    });
    return solanaKeypair;
  }

  const kp = solanaKeypair ?? gammaKeypair!;
  logger.info("EXECUTION", "getHouseKeypair", "Loaded house keypair", {
    pubkey: kp.publicKey.toBase58(),
  });
  return kp;
}

// Deprecated alias kept for compile compatibility.
export function getGammaKeypair(): Keypair | null {
  return getHouseKeypair();
}
