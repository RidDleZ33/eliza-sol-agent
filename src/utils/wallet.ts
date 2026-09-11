import { Connection, Keypair } from "@solana/web3.js";
import { env } from "./env.ts";

export function createConnection(): Connection {
  return new Connection(env.RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 30000,
  });
}

export function getGammaKeypair(): Keypair | null {
  if (!env.GAMMA_PRIVATE_KEY) {
    console.warn("GAMMA_PRIVATE_KEY not set; execution disabled");
    return null;
  }
  const keyBytes = Uint8Array.from(JSON.parse(env.GAMMA_PRIVATE_KEY));
  return Keypair.fromSecretKey(keyBytes);
}
