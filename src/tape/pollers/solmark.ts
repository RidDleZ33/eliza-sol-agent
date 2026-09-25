// SOL/USD mark poller
// Uses a well-known SOL/USDC pair on DexScreener (e.g., Raydium SOL/USDC)
// Writes to sol_marks table

import { getDb } from "../db";

const SOL_USDC_PAIR = "58oQChx4yW2t3T7c2GqN4GKvKkN7QgNqPmYqYqYqYqYq"; // Raydium SOL/USDC

export async function pollSolMark(): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${SOL_USDC_PAIR}`
    );
    if (!resp.ok) {
      console.log(`[solmark] HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    if (!data || !data.pair || !data.pair.priceUsd) {
      console.log("[solmark] no priceUsd in response");
      return null;
    }

    // priceUsd is for USDC (1.00). We need SOL price in USD.
    // Actually the pair is SOL/USDC so priceUsd = SOL price in USD
    const solUsd = parseFloat(data.pair.priceUsd);

    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO sol_marks (observed_at_ms, sol_usd, source)
      VALUES (?, ?, ?)
    `).run(now, solUsd, "dexscreener");

    console.log(`[solmark] SOL/USD = $${solUsd}`);
    return solUsd;
  } catch (err: any) {
    console.log(`[solmark] error: ${err.message}`);
    return null;
  }
}
