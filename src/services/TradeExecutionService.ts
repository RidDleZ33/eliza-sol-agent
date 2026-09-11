import { watchlistService } from "./WatchlistService.ts";
import { getSolanaPrivateKey } from "../utils/env.ts";
import { configService } from "./ConfigService.ts";

export interface TradeExecutionResult {
  success: boolean;
  txSignature?: string;
  error?: string;
  dryRun?: boolean;
}

export class TradeExecutionService {
  private runtime: any;

  constructor(runtime) {
    this.runtime = runtime;
  }

  async executeBuy(mintAddress: string, symbol: string, triggerType: string = "Trending Spike"): Promise<TradeExecutionResult> {
    try {
      this.runtime.logger.info(`[Gamma] Executing buy: ${symbol} (${mintAddress})`);

      // Check position limits
      const positionsCount = watchlistService.getActivePositionsCount();
      const maxPositions = configService.getNumber("MAX_CONCURRENT_POSITIONS");
      if (positionsCount >= maxPositions) {
        this.runtime.logger.info(`[Gamma] Position limit reached (${positionsCount}/${getMaxConcurrentPositions()})`);
        return {
          success: false,
          error: `Position limit reached: ${positionsCount}/${getMaxConcurrentPositions()}`
        };
      }

      // Check if already in position
      if (await watchlistService.hasPosition(mintAddress)) {
        this.runtime.logger.info(`[Gamma] Already in position for ${symbol}`);
        return {
          success: false,
          error: `Already in position for ${symbol}`
        };
      }

      const tradeSize = configService.getNumber("MAX_TRADE_SIZE_SOL");
      const slippageBps = configService.getNumber("SLIPPAGE_BPS");
      const jitoTipLamports = configService.getNumber("JITO_TIP_LAMPORTS");
      const dryRun = configService.getBoolean("DRY_RUN_MODE");

      if (dryRun) {
        // Dry run mode
        this.runtime.logger.info(`[Gamma] [DRY RUN] Would buy ${tradeSize} SOL of ${symbol} at slippage ${slippageBps} bps`);
        this.runtime.logger.info(`[Gamma] [DRY RUN] Jito tip: ${jitoTipLamports} lamports`);

        const result: TradeExecutionResult = {
          success: true,
          txSignature: "DRY_RUN_SIGNATURE",
          dryRun: true
        };

        // Still track position in dry run
        await watchlistService.addPosition(mintAddress, symbol, result.txSignature, 0, tradeSize);

        return result;
      }

      // Real execution
      this.runtime.logger.info(`[Gamma] Getting Jupiter quote for ${tradeSize} SOL -> ${symbol}`);

      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) {
        return { success: false, error: "Jupiter service not available" };
      }

      // Get quote
      const quote = await jupiterService.getQuote({
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: mintAddress,
        amount: tradeSize,
        slippageBps
      });

      if (!quote || !quote.outAmount) {
        return { success: false, error: "Failed to get quote from Jupiter" };
      }

      this.runtime.logger.info(`[Gamma] Quote: ${tradeSize} SOL -> ${quote.outAmount} ${symbol}`);

      // Execute swap
      const keypair = this.getKeypair();
      if (!keypair) {
        return { success: false, error: "SOLANA_PRIVATE_KEY not configured" };
      }

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps
      });

      if (!swapResult || !swapResult.tx) {
        return { success: false, error: "Failed to build swap transaction" };
      }

      // Sign transaction
      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      // Send to Jito block engine
      const jitoService = this.runtime.getService("JITO_SERVICE");
      let txSignature: string;

      if (jitoService) {
        this.runtime.logger.info(`[Gamma] Submitting to Jito block engine with tip ${jitoTipLamports} lamports`);
        txSignature = await jitoService.sendBundle([decoded]);
      } else {
        // Fallback to direct RPC send
        const connection = this.runtime.getService("SOLANA_CONNECTION");
        if (!connection) {
          return { success: false, error: "Solana connection not available" };
        }
        this.runtime.logger.info(`[Gamma] Jito not available, sending via RPC`);
        txSignature = await connection.sendTransaction(decoded);
      }

      // Confirm transaction
      if (jupiterService.confirmTransaction) {
        const connection = this.runtime.getService("SOLANA_CONNECTION");
        if (connection) {
          const confirmed = await jupiterService.confirmTransaction(connection, txSignature);
          if (!confirmed) {
            return { success: false, txSignature, error: "Transaction sent but not confirmed" };
          }
        }
      }

      this.runtime.logger.info(`[Gamma] Trade executed. TX: ${txSignature}`);

      // Record position
      await watchlistService.addPosition(mintAddress, symbol, txSignature, 0, tradeSize);

      return {
        success: true,
        txSignature
      };
    } catch (e) {
      this.runtime.logger.error(`[Gamma] Error executing buy:`, e);
      return {
        success: false,
        error: e.message || "Unknown error"
      };
    }
  }

  async executeSell(mintAddress: string, symbol: string, reason: string = "EXIT"): Promise<TradeExecutionResult> {
    try {
      this.runtime.logger.info(`[Gamma] Executing sell: ${symbol} (${mintAddress}) - ${reason}`);

      if (configService.getBoolean("DRY_RUN_MODE")) {
        this.runtime.logger.info(`[Gamma] [DRY RUN] Would sell ${symbol} position`);
        const result: TradeExecutionResult = {
          success: true,
          txSignature: "DRY_RUN_SELL_SIGNATURE",
          dryRun: true
        };
        return result;
      }

      const slippageBps = getSlippageBps();
      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) {
        return { success: false, error: "Jupiter service not available" };
      }

      // Get sell quote (Token -> SOL)
      const quote = await jupiterService.getQuote({
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112", // SOL
        amount: 100, // Sell 100% of position (Jupiter will use balance)
        slippageBps
      });

      if (!quote || !quote.outAmount) {
        return { success: false, error: "Failed to get sell quote" };
      }

      const keypair = this.getKeypair();
      if (!keypair) {
        return { success: false, error: "SOLANA_PRIVATE_KEY not configured" };
      }

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps
      });

      if (!swapResult || !swapResult.tx) {
        return { success: false, error: "Failed to build sell transaction" };
      }

      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      const connection = this.runtime.getService("SOLANA_CONNECTION");
      if (!connection) {
        return { success: false, error: "Solana connection not available" };
      }

      const txSignature = await connection.sendTransaction(decoded);
      
      if (jupiterService.confirmTransaction) {
        const confirmed = await jupiterService.confirmTransaction(connection, txSignature);
        if (!confirmed) {
          return { success: false, txSignature, error: "Sell transaction not confirmed" };
        }
      }

      this.runtime.logger.info(`[Gamma] Sell executed. TX: ${txSignature}`);
      return { success: true, txSignature };
    } catch (e) {
      this.runtime.logger.error(`[Gamma] Error executing sell:`, e);
      return { success: false, error: e.message || "Unknown error" };
    }
  }

  private getKeypair() {
    const privateKey = getSolanaPrivateKey();
    if (!privateKey) {
      return null;
    }

    try {
      const { Keypair } = await import("@solana/web3.js");
      const bytes = Buffer.from(privateKey, "base64");
      return Keypair.fromSecretKey(bytes);
    } catch (e) {
      this.runtime.logger.error(`[Gamma] Error creating keypair:`, e);
      return null;
    }
  }
}

export const tradeExecutionService = new TradeExecutionService(null);
export default tradeExecutionService;