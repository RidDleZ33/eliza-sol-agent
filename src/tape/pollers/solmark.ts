// SOL/USD mark poller
// Uses Raydium SOL/USDC pair

import { getDb } from "../db";

const SOL_USDC_PAIR = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

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
