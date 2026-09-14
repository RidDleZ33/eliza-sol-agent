import { watchlistService } from "./WatchlistService.ts";
import { getSolanaPrivateKey } from "../utils/env.ts";
import { configService } from "./ConfigService.ts";
import { logger } from "./LoggerService.ts";

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

  async executeBuy(
    mintAddress: string,
    symbol: string,
    triggerType: string = "Trending Spike"
  ): Promise<TradeExecutionResult> {
    logger.info("EXECUTION", "TradeExecution", "Starting buy execution", {
      symbol,
      mintAddress,
      triggerType,
    });

    try {
      // Check position limits
      const positionsCount = watchlistService.getActivePositionsCount();
      const maxPositions = configService.getNumber("MAX_CONCURRENT_POSITIONS");
      if (positionsCount >= maxPositions) {
        logger.warn("EXECUTION", "TradeExecution", "Position limit reached", {
          current: positionsCount,
          max: maxPositions,
          symbol,
        });
        return {
          success: false,
          error: `Position limit reached: ${positionsCount}/${maxPositions}`,
        };
      }

      // Check if already in position
      if (await watchlistService.hasPosition(mintAddress)) {
        logger.info("EXECUTION", "TradeExecution", "Already in position", {
          symbol,
          mintAddress,
        });
        return {
          success: false,
          error: `Already in position for ${symbol}`,
        };
      }

      const tradeSize = configService.getNumber("MAX_TRADE_SIZE_SOL");
      const slippageBps = configService.getNumber("SLIPPAGE_BPS");
      const jitoTipLamports = configService.getNumber("JITO_TIP_LAMPORTS");
      const dryRun = configService.getBoolean("DRY_RUN_MODE");

      logger.debug("EXECUTION", "TradeExecution", "Execution parameters", {
        tradeSize,
        slippageBps,
        jitoTipLamports,
        dryRun,
      });

      if (dryRun) {
        logger.info("EXECUTION", "TradeExecution", "[DRY RUN] Would execute buy", {
          symbol,
          tradeSize,
          slippageBps,
          jitoTipLamports,
        });

        const result: TradeExecutionResult = {
          success: true,
          txSignature: "DRY_RUN_SIGNATURE",
          dryRun: true,
        };

        await watchlistService.addPosition(
          mintAddress,
          symbol,
          result.txSignature,
          0,
          tradeSize
        );
        logger.info("EXECUTION", "TradeExecution", "Position added to watchlist", {
          symbol,
          mintAddress,
        });

        return result;
      }

      // Real execution
      logger.info("EXECUTION", "TradeExecution", "Getting Jupiter quote", {
        amountIn: tradeSize,
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mintAddress,
      });

      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) {
        logger.error("EXECUTION", "TradeExecution", "Jupiter service not available");
        return { success: false, error: "Jupiter service not available" };
      }

      const quote = await jupiterService.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mintAddress,
        amount: tradeSize,
        slippageBps,
      });

      if (!quote || !quote.outAmount) {
        logger.error("EXECUTION", "TradeExecution", "Failed to get quote from Jupiter");
        return { success: false, error: "Failed to get quote from Jupiter" };
      }

      logger.info("EXECUTION", "TradeExecution", "Quote received", {
        amountIn: tradeSize,
        amountOut: quote.outAmount,
        symbol,
      });

      const keypair = this.getKeypair();
      if (!keypair) {
        logger.error("EXECUTION", "TradeExecution", "SOLANA_PRIVATE_KEY not configured");
        return { success: false, error: "SOLANA_PRIVATE_KEY not configured" };
      }

      logger.debug("EXECUTION", "TradeExecution", "Building swap transaction");

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps,
      });

      if (!swapResult || !swapResult.tx) {
        logger.error("EXECUTION", "TradeExecution", "Failed to build swap transaction");
        return { success: false, error: "Failed to build swap transaction" };
      }

      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      const jitoService = this.runtime.getService("JITO_SERVICE");
      let txSignature: string;

      if (jitoService) {
        logger.info("EXECUTION", "TradeExecution", "Submitting to Jito block engine", {
          jitoTipLamports,
        });
        txSignature = await jitoService.sendBundle([decoded]);
      } else {
        const connection = this.runtime.getService("SOLANA_CONNECTION");
        if (!connection) {
          logger.error("EXECUTION", "TradeExecution", "Solana connection not available");
          return { success: false, error: "Solana connection not available" };
        }
        logger.info("EXECUTION", "TradeExecution", "Sending via RPC (Jito not available)");
        txSignature = await connection.sendTransaction(decoded);
      }

      logger.info("EXECUTION", "TradeExecution", "Transaction sent, awaiting confirmation", {
        txSignature,
      });

      if (jupiterService.confirmTransaction) {
        const connection = this.runtime.getService("SOLANA_CONNECTION");
        if (connection) {
          const confirmed = await jupiterService.confirmTransaction(connection, txSignature);
          if (!confirmed) {
            logger.warn("EXECUTION", "TradeExecution", "Transaction sent but not confirmed", {
              txSignature,
            });
            return {
              success: false,
              txSignature,
              error: "Transaction sent but not confirmed",
            };
          }
        }
      }

      logger.info("EXECUTION", "TradeExecution", "Trade executed successfully", {
        txSignature,
        symbol,
        mintAddress,
      });

      await watchlistService.addPosition(mintAddress, symbol, txSignature, 0, tradeSize);

      return {
        success: true,
        txSignature,
      };
    } catch (e) {
      logger.error("EXECUTION", "TradeExecution", "Error executing buy", {
        symbol,
        error: e.message,
      });
      return {
        success: false,
        error: e.message || "Unknown error",
      };
    }
  }

  async executeSell(
    mintAddress: string,
    symbol: string,
    reason: string = "EXIT"
  ): Promise<TradeExecutionResult> {
    logger.info("EXECUTION", "TradeExecution", "Starting sell execution", {
      symbol,
      mintAddress,
      reason,
    });

    try {
      if (configService.getBoolean("DRY_RUN_MODE")) {
        logger.info("EXECUTION", "TradeExecution", "[DRY RUN] Would execute sell", {
          symbol,
          reason,
        });
        const result: TradeExecutionResult = {
          success: true,
          txSignature: "DRY_RUN_SELL_SIGNATURE",
          dryRun: true,
        };
        return result;
      }

      const slippageBps = configService.getNumber("SLIPPAGE_BPS");
      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) {
        logger.error("EXECUTION", "TradeExecution", "Jupiter service not available");
        return { success: false, error: "Jupiter service not available" };
      }

      logger.info("EXECUTION", "TradeExecution", "Getting sell quote", {
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112",
      });

      const quote = await jupiterService.getQuote({
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112",
        amount: 100,
        slippageBps,
      });

      if (!quote || !quote.outAmount) {
        logger.error("EXECUTION", "TradeExecution", "Failed to get sell quote");
        return { success: false, error: "Failed to get sell quote" };
      }

      const keypair = this.getKeypair();
      if (!keypair) {
        logger.error("EXECUTION", "TradeExecution", "SOLANA_PRIVATE_KEY not configured");
        return { success: false, error: "SOLANA_PRIVATE_KEY not configured" };
      }

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps,
      });

      if (!swapResult || !swapResult.tx) {
        logger.error("EXECUTION", "TradeExecution", "Failed to build sell transaction");
        return { success: false, error: "Failed to build sell transaction" };
      }

      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      const connection = this.runtime.getService("SOLANA_CONNECTION");
      if (!connection) {
        logger.error("EXECUTION", "TradeExecution", "Solana connection not available");
        return { success: false, error: "Solana connection not available" };
      }

      logger.info("EXECUTION", "TradeExecution", "Sending sell transaction");

      const txSignature = await connection.sendTransaction(decoded);

      logger.info("EXECUTION", "TradeExecution", "Sell transaction sent", {
        txSignature,
      });

      if (jupiterService.confirmTransaction) {
        const confirmed = await jupiterService.confirmTransaction(
          connection,
          txSignature
        );
        if (!confirmed) {
          logger.warn("EXECUTION", "TradeExecution", "Sell transaction not confirmed", {
            txSignature,
          });
          return {
            success: false,
            txSignature,
            error: "Sell transaction not confirmed",
          };
        }
      }

      logger.info("EXECUTION", "TradeExecution", "Sell executed successfully", {
        txSignature,
        symbol,
      });
      return { success: true, txSignature };
    } catch (e) {
      logger.error("EXECUTION", "TradeExecution", "Error executing sell", {
        symbol,
        error: e.message,
      });
      return { success: false, error: e.message || "Unknown error" };
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
      logger.error("EXECUTION", "TradeExecution", "Error creating keypair", {
        error: e.message,
      });
      return null;
    }
  }
}

export const tradeExecutionService = new TradeExecutionService(null);
export default tradeExecutionService;