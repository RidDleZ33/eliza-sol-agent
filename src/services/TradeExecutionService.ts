import { watchlistService } from "./WatchlistService.ts";
import { isDryRun } from "../utils/env.ts";
import { getHouseKeypair } from "../utils/wallet.ts";
import { configService } from "./ConfigService.ts";
import { logger } from "./LoggerService.ts";
import { jupiterQuote, SOL_MINT } from "../execution/jupiterQuote.ts";

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

  private async getTokenPrice(mint: string): Promise<number> {
    logger.info("EXECUTION", "TradeExecution", "Fetching token price", { mint });
    logger.info("EXECUTION", "TradeExecution", "Runtime available", { hasRuntime: !!this.runtime });
    
    try {
      // Try Jupiter Price API
      const jupiterService = this.runtime?.getService?.("JUPITER_SERVICE");
      logger.info("EXECUTION", "TradeExecution", "Jupiter service check", {
        hasJupiterService: !!jupiterService,
        hasGetTokenPrice: !!(jupiterService && jupiterService.getTokenPrice)
      });
      
      if (jupiterService && jupiterService.getTokenPrice) {
        logger.info("EXECUTION", "TradeExecution", "Calling Jupiter getTokenPrice");
        const price = await jupiterService.getTokenPrice(mint);
        logger.info("EXECUTION", "TradeExecution", "Jupiter price returned", { price });
        if (price > 0) return price;
      }

      // Fallback to DexScreener
      logger.info("EXECUTION", "TradeExecution", "Falling back to DexScreener");
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      logger.info("EXECUTION", "TradeExecution", "DexScreener URL", { url });
      
      const response = await fetch(url);
      logger.info("EXECUTION", "TradeExecution", "DexScreener response", { ok: response.ok, status: response.status });
      
      if (response.ok) {
        const data = await response.json();
        logger.info("EXECUTION", "TradeExecution", "DexScreener data received", {
          hasPair: !!data?.pair?.[0],
          pairCount: data?.pairs?.length ?? 0
        });
        
        const pair = data?.pairs?.[0];
        if (pair && pair.priceUsd) {
          logger.info("EXECUTION", "TradeExecution", "DexScreener price found", { price: pair.priceUsd });
          return parseFloat(pair.priceUsd);
        }
        logger.info("EXECUTION", "TradeExecution", "No price in DexScreener pair", { pair });
      }
    } catch (e) {
      logger.error("EXECUTION", "TradeExecution", "Error fetching token price", {
        mint,
        error: e.message,
        stack: e.stack
      });
    }

    logger.warn("EXECUTION", "TradeExecution", "Could not determine price, returning 0", { mint });
    return 0;
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
      // Phase 0F: env DRY_RUN=true must prevent live even if ConfigService is toggled
      const dryRun = isDryRun() || configService.getBoolean("DRY_RUN_MODE");

      if (dryRun) {
        // Idempotency lite: client_order_id logged for Phase 1B persistence
        const now = new Date();
        const clientOrderId = `buy:${mintAddress}:${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}`;
        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY starting", {
          symbol,
          convictionScore,
          tradeSize,
          clientOrderId,
        });

        // Fetch real Jupiter quote instead of pretending
        const inAmount = Math.round(tradeSize * 1e9);
        const quote = await jupiterQuote(SOL_MINT, mintAddress, inAmount, slippageBps);
        if (!quote) {
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] BUY quote failed, not opening position", { symbol });
          return { success: false, error: "quote failed", dryRun: true };
        }

        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY quoted", {
          symbol,
          in: inAmount,
          out: quote.outAmount,
          priceImpact: quote.priceImpactPct,
        });

        const entryPrice = await this.getTokenPrice(mintAddress);
        const txSignature = "DRY_RUN_BUY_" + Date.now();
        // Log quote details in position metadata via reason field
        const quoteMeta = JSON.stringify({ quoteIn: quote.inAmount, quoteOut: quote.outAmount, priceImpact: quote.priceImpactPct });
        await watchlistService.addPosition(mintAddress, symbol, txSignature, entryPrice, tradeSize);
        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY position opened", {
          symbol,
          signature: txSignature,
          quoteMeta,
        });
        return { success: true, txSignature, dryRun: true };
      }

      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY executing", {
        symbol,
        convictionScore,
        tradeSize,
      });
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

      const keypair = getHouseKeypair();
      if (!keypair) return { success: false, error: "House keypair missing or invalid (set SOLANA_PRIVATE_KEY or GAMMA_PRIVATE_KEY)" };

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

      const entryPrice = await this.getTokenPrice(mintAddress);
      await watchlistService.addPosition(mintAddress, symbol, txSignature, entryPrice, tradeSize);
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
      // Phase 0F: env DRY_RUN=true must prevent live even if ConfigService is toggled
      const dryRun = isDryRun() || configService.getBoolean("DRY_RUN_MODE");
      if (dryRun) {
        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] SELL starting", { symbol, reason });

        // Try to get a reverse quote for sell value (best-effort)
        const sellMarkPrice = await this.getTokenPrice(mintAddress);
        if (sellMarkPrice <= 0) {
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] SELL mark price missing", { symbol });
        }

        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] SELL completed", { symbol, reason, sellMarkPrice });
        return { success: true, txSignature: "DRY_RUN_SELL_" + Date.now(), dryRun: true };
      }
      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL executing", { symbol, reason });

      const jupiterService = this.runtime.getService("JUPITER_SERVICE");
      if (!jupiterService) return { success: false, error: "Jupiter service unavailable" };

      // Get actual token balance to sell full position
      const tokenBalance = await this.getTokenBalance(mintAddress);
      if (!tokenBalance) return { success: false, error: "Could not determine token balance for sell" };

      const quote = await jupiterService.getQuote({
        inputMint: mintAddress,
        outputMint: "So11111111111111111111111111111111111111112",
        amount: tokenBalance,
        slippageBps: configService.getNumber("SLIPPAGE_BPS"),
      });

      if (!quote || !quote.outAmount) return { success: false, error: "Failed to get sell quote" };

      const keypair = getHouseKeypair();
      if (!keypair) return { success: false, error: "House keypair missing" };

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

  private async getTokenBalance(mint: string): Promise<number | null> {
    try {
      const keypair = getHouseKeypair();
      if (!keypair) return null;

      const connection = this.runtime?.getService?.("SOLANA_CONNECTION");
      if (!connection) return null;

      const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");
      const ata = await getAssociatedTokenAddress(
        new (require("@solana/web3.js").PublicKey)(mint),
        keypair.publicKey
      );

      const accountInfo = await connection.getAccountInfo(ata);
      if (!accountInfo) return 0;

      // Parse SPL token account balance (bytes 64-71)
      const balance = accountInfo.data.readBigUInt64LE(64);
      return Number(balance);
    } catch (e) {
      logger.error("EXECUTION", "TradeExecution", "Error getting token balance", {
        mint,
        error: e.message,
      });
      return null;
    }
  }
}

export const tradeExecutionService = new TradeExecutionService(null);
export default tradeExecutionService;
