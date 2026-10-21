// Phase 24B: Jito bundle path for live sells.
// Builds a tip transaction and bundles swap + tip to Jito block engine.
// Falls back to null on any failure so caller can use public sendRawTransaction.

import {
  SystemProgram,
  VersionedTransaction,
  Keypair,
  PublicKey,
  TransactionMessage,
  toBase58,
} from "@solana/web3.js";
import { env } from "../utils/env.ts";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function randomTipAccount(): string {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

export async function sendJitoSellBundle(
  swapTx: VersionedTransaction,
  keypair: Keypair,
  blockhash: string,
  tipLamports: number
): Promise<string | null> {
  try {
    const tipAccount = randomTipAccount();

    // Build tip transaction
    const tipIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    });

    const tipMessage = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMessage);
    tipTx.sign([keypair]);

    // Encode transactions as base64 (bs58 not a dependency)
    const swapB64 = Buffer.from(swapTx.serialize()).toString("base64");
    const tipB64 = Buffer.from(tipTx.serialize()).toString("base64");

    // POST to Jito bundle endpoint
    const response = await fetch(env.JITO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [[swapB64, tipB64], { encoding: "base64" }],
      }),
    });

    if (!response.ok) {
      console.warn(`[jito] bundle send failed HTTP ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (!result || !result.result) {
      console.warn("[jito] bundle send missing result", result);
      return null;
    }

    // Return swap signature (base58)
    const swapSig = swapTx.signatures[0];
    if (!swapSig) {
      console.warn("[jito] swap tx missing signature");
      return null;
    }
    return toBase58(swapSig);
  } catch (e: any) {
    console.warn("[jito] bundle send error:", e.message);
    return null;
  }
}