import { watchlistService } from "./WatchlistService.ts";
import { getSolanaPrivateKey } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";
import { configService } from "./ConfigService.ts";

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

      // Determine current mode
      const isDryRun = configService.getBoolean("DRY_RUN_MODE");
      const recoveryMode = isDryRun ? "DRY_RUN" : "LIVE";
      log(`[CrashRecovery] Recovery mode: ${recoveryMode}`);

      // Get positions matching current mode by tx signature prefix
      let positionsToRecover: any[];
      if (isDryRun) {
        positionsToRecover = await watchlistService.getOpenPositions(true);
      } else {
        positionsToRecover = await watchlistService.getOpenPositions(false);
      }
      log(`[CrashRecovery] Found ${positionsToRecover.length} open positions matching mode ${recoveryMode}`);

      for (const position of positionsToRecover) {
        try {
          if (isDryRun) {
            // Dry run positions are simulated - just confirm they're restored
            log(`[CrashRecovery] [DRY_RUN] Position ${position.symbol} restored (simulated)`);
          } else {
            // Live positions need blockchain balance verification
            const balance = await this.getTokenBalance(position.mint_address, logWarn);
            
            if (balance > 0) {
              log(`[CrashRecovery] [LIVE] Position ${position.symbol} still active (balance: ${balance})`);
            } else {
              log(`[CrashRecovery] [LIVE] Position ${position.symbol} closed externally (balance: 0)`);
              await watchlistService.updatePositionStatus(
                position.mint_address,
                "CLOSED_EXTERNALLY"
              );
            }
          }
        } catch (e) {
          logError(`[CrashRecovery] Error checking position ${position.symbol}:`, e);
        }
      }

      log("[CrashRecovery] Position reconciliation complete");
      return positionsToRecover.length;
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