import { watchlistService } from "./WatchlistService.ts";
import { getHouseKeypair } from "../utils/wallet.ts";
import { getSolanaRpcUrl } from "../utils/env.ts";
import { logger } from "./LoggerService.ts";
import { configService } from "./ConfigService.ts";

export class CrashRecoveryService {
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
              await watchlistService.logTradeRow({
                clientOrderId: `sell-recover:${position.mint_address}:${Date.now()}`,
                mint: position.mint_address,
                symbol: position.symbol,
                side: "SELL",
                mode: "LIVE",
                txSig: position.buy_tx_signature,
                status: "CLOSED_EXTERNALLY",
                reason: "crash-recovery",
              });
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
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const keypair = getHouseKeypair();
    if (!keypair) {
      logWarn("[CrashRecovery] No house keypair available for balance check");
      return 0;
    }

    try {
      const connection = new Connection(getSolanaRpcUrl(), "confirmed");

      // Use parsed accounts for both Token and Token-2022 (same as TradeExecutionService)
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new PublicKey(mintAddress) }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      const account = tokenAccounts.value[0];
      const tokenAmount = account.account.data.parsed.info.tokenAmount;
      return Number(tokenAmount.amount);
    } catch (e: any) {
      logWarn(`[CrashRecovery] Balance check failed for ${mintAddress}: ${e.message}`);
      return 0;
    }
  }
}

export const crashRecoveryService = new CrashRecoveryService();
export default crashRecoveryService;