import { Connection, PublicKey } from "@solana/web3.js";
import { watchlistService } from "./WatchlistService.ts";
import { getSolanaRpcUrl, getWalletMirrorInterval } from "../utils/env.ts";

// Jupiter program ID for swap detection
const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

export interface WalletMirrorEvent {
  trader_wallet: string;
  mint_address: string;
  symbol?: string;
  sol_amount: number;
  transaction_signature: string;
  timestamp: number;
}

export class WalletMirrorService {
  private connection: Connection;
  private lastSeenSignatures: Map<string, string>; // wallet -> last sig
  private runtime: any;

  constructor(runtime) {
    this.runtime = runtime;
    this.connection = new Connection(getSolanaRpcUrl(), "confirmed");
    this.lastSeenSignatures = new Map();
  }

  async startMirroring() {
    this.runtime.logger.info("[Beta] Starting wallet mirroring service");

    while (true) {
      try {
        const traders = await watchlistService.getWatchedTraders();

        for (const trader of traders) {
          try {
            await this.pollTrader(trader.address);
          } catch (e) {
            this.runtime.logger.error(
              `[Beta] Error polling trader ${trader.address}:`,
              e
            );
          }
        }

        // Wait for next poll interval
        await this.sleep(getWalletMirrorInterval());
      } catch (e) {
        this.runtime.logger.error("[Beta] Error in mirroring loop:", e);
        await this.sleep(getWalletMirrorInterval());
      }
    }
  }

  private async pollTrader(walletAddress: string) {
    const pubkey = new PublicKey(walletAddress);

    // Get recent transaction signatures for this wallet
    const signatures = await this.connection.getSignaturesForAddress(pubkey, {
      limit: 5,
    });

    // Filter out already-seen signatures
    const lastSeen = this.lastSeenSignatures.get(walletAddress) || "";
    const newSignatures = signatures.filter((s) => s.signature !== lastSeen);

    for (const sigInfo of newSignatures) {
      try {
        const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) continue;

        // Check for swap instructions (Jupiter)
        const swapEvent = this.parseSwapFromTransaction(tx);
        if (swapEvent && swapEvent.mint_address) {
          // Emit event to war room
          this.runtime.logger.info(
            `[Beta] TOP_TRADER_BUY_DETECTED: ${walletAddress} bought ${swapEvent.mint_address} for ${swapEvent.sol_amount} SOL`
          );

          const channel = this.runtime.getRoom("warmroom");
          if (channel) {
            channel.publish({
              author: { name: "Beta" },
              text: JSON.stringify({
                event: "TOP_TRADER_BUY_DETECTED",
                trader_wallet: walletAddress,
                mint_address: swapEvent.mint_address,
                symbol: swapEvent.symbol,
                sol_amount: swapEvent.sol_amount,
                transaction_signature: sigInfo.signature,
                timestamp: Date.now(),
              }),
              timestamp: Date.now(),
            });
          }
        }
      } catch (e) {
        this.runtime.logger.error(
          `[Beta] Error parsing transaction ${sigInfo.signature}:`,
          e
        );
      }
    }

    // Update last seen signature
    if (signatures.length > 0) {
      this.lastSeenSignatures.set(walletAddress, signatures[0].signature);
    }
  }

  private parseSwapFromTransaction(
    tx: any
  ): { mint_address: string; sol_amount: number; symbol?: string } | null {
    // Simplified swap parsing - look for token transfers
    // In production, this would use specific Jupiter/Raydium parsers

    const instructions = tx?.transaction?.instructions || [];

    for (const ix of instructions) {
      if (ix.programId?.toBase58() === JUPITER_PROGRAM_ID.toBase58()) {
        // Found Jupiter swap instruction
        // Parse input/output from accounts and data
        try {
          // Simplified: detect SOL->token swaps by checking account changes
          // TODO: Parse actual instruction data for mint and SOL amount
          return {
            mint_address: "DETECTED_MINT", // Would be parsed from instruction data
            sol_amount: 1.0, // Default - would be calculated from balance changes
          };
        } catch (e) {
          // Continue parsing
        }
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const walletMirrorService = new WalletMirrorService(null);
export default walletMirrorService;