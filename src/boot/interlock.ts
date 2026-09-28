import { isDryRun } from "../utils/env.ts";
import { env } from "../utils/env.ts";
import { getHouseKeypair } from "../utils/wallet.ts";

export interface InterlockResult {
  mode: "DRY_RUN" | "LIVE";
  rpcHost: string;
  dryRun: boolean;
  maxSol: number;
  elizaBoot: number;
}

function getRpcHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

export function runInterlock(): InterlockResult {
  const dryRun = isDryRun();
  const mode = dryRun ? "DRY_RUN" : "LIVE";
  const rpcUrl = process.env.SOLANA_RPC_URL || env.RPC_URL;
  const rpcHost = getRpcHost(rpcUrl);
  const maxSol = parseFloat(env.MAX_TRADE_SIZE_SOL);
  const elizaBoot = process.env.ELIZA_BOOT === "1" ? 1 : 0;

  console.log(`[boot] mode=${mode} rpc=${rpcHost} dry_run=${dryRun} max_sol=${maxSol} eliza_boot=${elizaBoot}`);

  if (mode === "DRY_RUN") {
    if (rpcHost === "api.mainnet-beta.solana.com") {
      console.warn("[boot] WARNING: DRY_RUN but RPC is public mainnet default");
    }
    return { mode, rpcHost, dryRun, maxSol, elizaBoot };
  }

  // LIVE refuse checks
  const keypair = getHouseKeypair();
  if (!keypair) {
    console.error("[boot] REFUSE LIVE: no house keypair. Set SOLANA_PRIVATE_KEY or GAMMA_PRIVATE_KEY.");
    process.exit(1);
  }

  if (rpcHost === "api.mainnet-beta.solana.com") {
    console.error("[boot] REFUSE LIVE: RPC is public mainnet default. Use a paid/private RPC.");
    process.exit(1);
  }

  if (!Number.isFinite(maxSol) || maxSol <= 0) {
    console.error(`[boot] REFUSE LIVE: MAX_TRADE_SIZE_SOL invalid (${env.MAX_TRADE_SIZE_SOL}).`);
    process.exit(1);
  }

  const tgChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!tgChatId) {
    console.error("[boot] REFUSE LIVE: TELEGRAM_ADMIN_CHAT_ID not set.");
    process.exit(1);
  }

  return { mode, rpcHost, dryRun, maxSol, elizaBoot };
}
