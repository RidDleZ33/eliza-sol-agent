import { watchlistService } from "./WatchlistService.ts";
import { getSolanaPrivateKey } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";

export class CrashRecoveryService {
  private runtime: any;

  constructor(runtime) {
    this.runtime = runtime;
  }

  async reconcilePositions() {
    const log = (msg: string) => logger.info("CRASH_RECOVERY", "CrashRecovery", msg);
    const logError = (msg: string, error?: unknown) => logger.error("CRASH_RECOVERY", "CrashRecovery", msg, { error: error?.message || String(error) });
    const logWarn = (msg: string) => logger.warn("CRASH_RECOVERY", "CrashRecovery", msg);

    try {
      log("[CrashRecovery] Reconciling positions...");

      // Get all open positions from DB
      const openPositions = await watchlistService.getOpenPositions();
      
      log(`[CrashRecovery] Found ${openPositions.length} open positions in DB`);

      for (const position of openPositions) {
        try {
          // Check actual wallet balance
          const balance = await this.getTokenBalance(position.mint_address, logWarn);
          
          if (balance > 0) {
            log(`[CrashRecovery] Position ${position.symbol} still active (balance: ${balance})`);
            // Position is still valid, keep it open
          } else {
            log(`[CrashRecovery] Position ${position.symbol} closed externally (balance: 0)`);
            await watchlistService.updatePositionStatus(
              position.mint_address,
              "CLOSED_EXTERNALLY"
            );
          }
        } catch (e) {
          logError(`[CrashRecovery] Error checking position ${position.symbol}:`, e);
        }
      }

      log("[CrashRecovery] Position reconciliation complete");
      return openPositions.length;
    } catch (e) {
      logError("[CrashRecovery] Error during reconciliation:", e);
      return 0;
    }
  }

  private async getTokenBalance(mintAddress: string, logWarn: any): Promise<number> {
    const connection = this.runtime?.getService?.("SOLANA_CONNECTION");
    if (!connection) {
      logWarn("[CrashRecovery] Solana connection not available for balance check");
      return 0;
    }

    const privateKey = getSolanaPrivateKey();
    if (!privateKey) {
      logWarn("[CrashRecovery] SOLANA_PRIVATE_KEY not configured");
      return 0;
    }

    try {
      const { PublicKey } = await import("@solana/web3.js");
      const keypair = this.getKeypair();
      if (!keypair) {
        return 0;
      }

      // Get token accounts for this mint
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(mintAddress) }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      // Get balance of first token account
      const account = tokenAccounts.value[0];
      const balance = await connection.getTokenAccountBalance(account.pubkey);
      return balance.value.uiAmount || 0;
    } catch (e) {
      logError(`[CrashRecovery] Error getting balance for ${mintAddress}:`, e);
      return 0;
    }
  }

  private getKeypair() {
    const privateKey = getSolanaPrivateKey();
    if (!privateKey) {
      return null;
    }

    try {
      const { Keypair } = require("@solana/web3.js");
      const bytes = Buffer.from(privateKey, "base64");
      return Keypair.fromSecretKey(bytes);
    } catch (e) {
      return null;
    }
  }
}

export const crashRecoveryService = new CrashRecoveryService(null);
export default crashRecoveryService;