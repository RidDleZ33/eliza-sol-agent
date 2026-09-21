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

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  async executeBuy(
    mintAddress: string,
    symbol: string,
    convictionScore: number = 0.75,
    triggerType: string = "Committee Consensus"
  ): Promise<TradeExecutionResult> {
    logger.info("EXECUTION", "TradeExecution", "Starting conviction-backed buy execution", {
      symbol,
      mintAddress,
      convictionScore,
      triggerType,
    });

    try {
      const positionsCount = watchlistService.getActivePositionsCount();
      const maxPositions = configService.getNumber("MAX_CONCURRENT_POSITIONS");
      if (positionsCount >= maxPositions) {
        return { success: false, error: `Max position limit reached (${positionsCount}/${maxPositions})` };
      }

      if (await watchlistService.hasPosition(mintAddress)) {
        return { success: false, error: `Already in open position for ${symbol}` };
      }

      // Dynamic Position Sizing based on Conviction Score
      const baseTradeSize = configService.getNumber("MAX_TRADE_SIZE_SOL");
      const dynamicMultiplier = Math.min(1.25, Math.max(0.5, convictionScore));
      const tradeSize = parseFloat((baseTradeSize * dynamicMultiplier).toFixed(4));

      const slippageBps = configService.getNumber("SLIPPAGE_BPS");
      const dryRun = configService.getBoolean("DRY_RUN_MODE");

      if (dryRun) {
        logger.info("EXECUTION", "TradeExecution", "[DRY RUN] Dynamic Buy Simulated", {
          symbol,
          convictionScore,
          tradeSize,
        });

        const txSignature = "DRY_RUN_BUY_" + Date.now();
        await watchlistService.addPosition(mintAddress, symbol, txSignature, 0, tradeSize);
        return { success: true, txSignature, dryRun: true };
      }

      // Real Execution Path
      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) return { success: false, error: "Jupiter service unavailable" };

      const quote = await jupiterService.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mintAddress,
        amount: Math.round(tradeSize * 1e9),
        slippageBps,
      });

      if (!quote || !quote.outAmount) return { success: false, error: "Failed to fetch Jupiter quote" };

      const keypair = this.getKeypair();
      if (!keypair) return { success: false, error: "SOLANA_PRIVATE_KEY missing or invalid" };

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps,
      });

      if (!swapResult?.tx) return { success: false, error: "Swap transaction build failed" };

      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      const jitoService = this.runtime.getService("JITO_SERVICE");
      let txSignature: string;

      if (jitoService) {
        txSignature = await jitoService.sendBundle([decoded]);
      } else {
        const connection = this.runtime.getService("SOLANA_CONNECTION");
        if (!connection) return { success: false, error: "Solana RPC connection unavailable" };
        txSignature = await connection.sendTransaction(decoded);
      }

      await watchlistService.addPosition(mintAddress, symbol, txSignature, 0, tradeSize);
      return { success: true, txSignature };

    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "Buy Execution Error", { symbol, error: e.message });
      return { success: false, error: e.message || "Unknown execution error" };
    }
  }

  async executeSell(
    mintAddress: string,
    symbol: string,
    reason: string = "EXIT"
  ): Promise<TradeExecutionResult> {
    logger.info("EXECUTION", "TradeExecution", "Executing sell order", { symbol, reason });

    try {
      if (configService.getBoolean("DRY_RUN_MODE")) {
        logger.info("EXECUTION", "TradeExecution", "[DRY RUN] Sell Simulated", { symbol, reason });
        return { success: true, txSignature: "DRY_RUN_SELL_" + Date.now(), dryRun: true };
      }

      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) return { success: false, error: "Jupiter service unavailable" };

      const quote = await jupiterService.getQuote({
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112",
        amount: 100, // 100% of token account balance
        slippageBps: configService.getNumber("SLIPPAGE_BPS"),
      });

      if (!quote || !quote.outAmount) return { success: false, error: "Failed to get sell quote" };

      const keypair = this.getKeypair();
      if (!keypair) return { success: false, error: "SOLANA_PRIVATE_KEY missing" };

      const swapResult = await jupiterService.executeSwap({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        slippageBps: configService.getNumber("SLIPPAGE_BPS"),
      });

      const transaction = Buffer.from(swapResult.tx, "base64");
      const decoded = await jupiterService.deserializeTransaction(transaction);
      decoded.sign([keypair]);

      const connection = this.runtime.getService("SOLANA_CONNECTION");
      const txSignature = await connection.sendTransaction(decoded);

      return { success: true, txSignature };
    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "Sell execution failed", { symbol, error: e.message });
      return { success: false, error: e.message };
    }
  }

  private getKeypair() {
    const privateKey = getSolanaPrivateKey();
    if (!privateKey) return null;
    try {
      const { Keypair } = require("@solana/web3.js");
      const bytes = Buffer.from(privateKey, "base64");
      return Keypair.fromSecretKey(bytes);
    } catch {
      return null;
    }
  }
}

export const tradeExecutionService = new TradeExecutionService(null);
export default tradeExecutionService;
