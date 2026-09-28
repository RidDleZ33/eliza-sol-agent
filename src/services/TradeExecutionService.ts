// Phase 1C: Live fill via Jupiter HTTP API + direct Solana RPC.
// Not wired to Jito; public sendRawTransaction + confirmTransaction.
// Dry-run: quote only, never builds swap tx or sends.

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { watchlistService } from "./WatchlistService.ts";
import { isDryRun, getSolanaRpcUrl } from "../utils/env.ts";
import { getHouseKeypair } from "../utils/wallet.ts";
import { configService } from "./ConfigService.ts";
import { logger } from "./LoggerService.ts";
import { jupiterQuote, jupiterBuildSwap, SOL_MINT } from "../execution/jupiterApi.ts";
import {
  checkBuyRisk,
  maxTradeSizeSol,
  jupiterBreakerOpen,
  tripJupiterBreaker,
  resetJupiterBreaker,
  rpcBreakerOpen,
  tripRpcBreaker,
  resetRpcBreaker,
} from "../execution/risk.ts";

export interface TradeExecutionResult {
  success: boolean;
  txSignature?: string;
  error?: string;
  dryRun?: boolean;
}

export class TradeExecutionService {
  runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  private getConnection(): Connection {
    return new Connection(getSolanaRpcUrl(), "confirmed");
  }

  /**
   * Phase 1B: Live sell with simulate-send-confirm.
   */
  private async executeLiveSell(
    mintAddress: string,
    symbol: string,
    reason: string
  ): Promise<TradeExecutionResult> {
    const connection = this.getConnection();
    const keypair = getHouseKeypair();
    if (!keypair) {
      return { success: false, error: "House keypair missing (set SOLANA_PRIVATE_KEY or GAMMA_PRIVATE_KEY)" };
    }

    const slippageBps = configService.getNumber("SLIPPAGE_BPS");

    try {
      // 1. Get raw token balance from chain (both Token and Token-2022)
      const tokenBalance = await this.getTokenBalance(connection, keypair.publicKey, mintAddress);
      if (!tokenBalance) {
        return { success: false, error: "Could not determine token balance for sell" };
      }
      if (tokenBalance === 0) {
        return { success: false, error: "Token balance is 0; nothing to sell" };
      }

      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL quoting", {
        symbol,
        mint: mintAddress,
        amount: tokenBalance,
      });

      // 2. Quote (token -> SOL) with Jupiter breaker
      if (jupiterBreakerOpen()) {
        logger.warn("EXECUTION", "TradeExecution", "[breaker] jupiter OPEN", { symbol });
        return { success: false, error: "Jupiter circuit breaker is open" };
      }
      const quoteResult = await jupiterQuote(mintAddress, SOL_MINT, tokenBalance, slippageBps);
      if (!quoteResult) {
        tripJupiterBreaker();
        return { success: false, error: "Failed to get sell quote" };
      }
      resetJupiterBreaker();

      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL quoted", {
        symbol,
        in: quoteResult.slim.inAmount,
        out: quoteResult.slim.outAmount,
      });

      // 3. Build swap tx via /swap/v1/swap
      const swapB64 = await jupiterBuildSwap(quoteResult.raw, keypair.publicKey.toBase58());
      if (!swapB64) {
        return { success: false, error: "Swap transaction build failed" };
      }

      // 4. Deserialize
      let decoded: VersionedTransaction;
      try {
        const buffer = Buffer.from(swapB64, "base64");
        decoded = VersionedTransaction.deserialize(buffer);
      } catch (e: any) {
        // Legacy fallback
        try {
          const { Transaction } = require("@solana/web3.js");
          const buffer = Buffer.from(swapB64, "base64");
          decoded = Transaction.deserialize(buffer);
        } catch (e2: any) {
          return { success: false, error: `Transaction deserialize failed: ${e2.message}` };
        }
      }

      // 5. Simulate
      const simResult = await connection.simulateTransaction(decoded, {
        replaceRecentBlockhash: true,
      });
      if (simResult.value.err) {
        const logs = simResult.value.logs || [];
        logger.warn("EXECUTION", "TradeExecution", "[LIVE] SELL simulation failed", {
          symbol,
          err: simResult.value.err.toString(),
          logs: logs.slice(-5),
        });
        return {
          success: false,
          error: `Simulation failed: ${simResult.value.err}`,
        };
      }

      // 6. Sign
      decoded.sign([keypair]);

      // 6b. Capture blockhash BEFORE send (phase 2A: reuse in confirm, no second fetch)
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      // 7. Send with preflight (RPC breaker)
      if (rpcBreakerOpen()) {
        logger.warn("EXECUTION", "TradeExecution", "[breaker] rpc OPEN", { symbol });
        return { success: false, error: "RPC circuit breaker is open" };
      }
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(decoded.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });
        resetRpcBreaker();
      } catch (e: any) {
        tripRpcBreaker();
        return { success: false, error: `sendRawTransaction failed: ${e.message}` };
      }

      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL sent", {
        symbol,
        signature,
      });

      // 8. Confirm using the SAME blockhash captured before send
      let sellConfirmError: string | null = null;
      try {
        const status = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        if (status.value.err) {
          sellConfirmError = `Transaction failed: ${status.value.err.toString()}`;
        }
      } catch (e: any) {
        sellConfirmError = `confirmTransaction failed: ${e.message}`;
      }

      if (sellConfirmError) {
        // Phase 2A: FAILED journal row
        await watchlistService.logTradeRow({
          clientOrderId: `sell-live:${mintAddress}:${signature}`,
          mint: mintAddress,
          symbol,
          side: "SELL",
          mode: "LIVE",
          txSig: signature,
          status: "FAILED",
          reason: sellConfirmError,
        });
        return {
          success: false,
          txSignature: signature,
          error: sellConfirmError,
        };
      }

      // 9. Close position in watchlist
      await watchlistService.closePosition(mintAddress, signature);

      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL completed", {
        symbol,
        signature,
        reason,
      });

      // Phase 2A: FILLED journal row
      await watchlistService.logTradeRow({
        clientOrderId: `sell-live:${mintAddress}:${signature}`,
        mint: mintAddress,
        symbol,
        side: "SELL",
        mode: "LIVE",
        solOut: Number(quoteResult.slim.outAmount) / 1e9,
        txSig: signature,
        status: "FILLED",
        reason: reason,
      });

      return { success: true, txSignature: signature };
    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "[LIVE] SELL error", {
        symbol,
        error: e.message,
      });
      return { success: false, error: e.message || "Unknown error" };
    }
  }

  /**
   * Phase 1B: Live buy with simulate-send-confirm.
   */
  private async executeLiveBuy(
    mintAddress: string,
    symbol: string,
    convictionScore: number,
    tradeSize: number,
    triggerType: string
  ): Promise<TradeExecutionResult> {
    const connection = this.getConnection();
    const keypair = getHouseKeypair();
    if (!keypair) {
      return { success: false, error: "House keypair missing (set SOLANA_PRIVATE_KEY or GAMMA_PRIVATE_KEY)" };
    }

    const slippageBps = configService.getNumber("SLIPPAGE_BPS");
    const inAmount = Math.round(tradeSize * 1e9);

    try {
      // 1. Quote (SOL -> token)
      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY quoting", {
        symbol,
        sol: tradeSize,
      });

      const quoteResult = await jupiterQuote(SOL_MINT, mintAddress, inAmount, slippageBps);
      if (!quoteResult) {
        tripJupiterBreaker();
        return { success: false, error: "Failed to get buy quote" };
      }
      resetJupiterBreaker();

      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY quoted", {
        symbol,
        in: quoteResult.slim.inAmount,
        out: quoteResult.slim.outAmount,
      });

      // 2. Build swap tx via /swap/v1/swap
      const swapB64 = await jupiterBuildSwap(quoteResult.raw, keypair.publicKey.toBase58());
      if (!swapB64) {
        return { success: false, error: "Swap transaction build failed" };
      }

      // 3. Deserialize
      let decoded: VersionedTransaction;
      try {
        const buffer = Buffer.from(swapB64, "base64");
        decoded = VersionedTransaction.deserialize(buffer);
      } catch (e: any) {
        try {
          const { Transaction } = require("@solana/web3.js");
          const buffer = Buffer.from(swapB64, "base64");
          decoded = Transaction.deserialize(buffer);
        } catch (e2: any) {
          return { success: false, error: `Transaction deserialize failed: ${e2.message}` };
        }
      }

      // 4. Simulate
      const simResult = await connection.simulateTransaction(decoded, {
        replaceRecentBlockhash: true,
      });
      if (simResult.value.err) {
        const logs = simResult.value.logs || [];
        logger.warn("EXECUTION", "TradeExecution", "[LIVE] BUY simulation failed", {
          symbol,
          err: simResult.value.err.toString(),
          logs: logs.slice(-5),
        });
        return {
          success: false,
          error: `Simulation failed: ${simResult.value.err}`,
        };
      }

      // 5. Sign
      decoded.sign([keypair]);

      // 6. Capture blockhash BEFORE send (phase 2A: reuse in confirm, no second fetch)
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      // 7. Send with preflight (RPC breaker)
      if (rpcBreakerOpen()) {
        logger.warn("EXECUTION", "TradeExecution", "[breaker] rpc OPEN", { symbol });
        return { success: false, error: "RPC circuit breaker is open" };
      }
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(decoded.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });
        resetRpcBreaker();
      } catch (e: any) {
        tripRpcBreaker();
        return { success: false, error: `sendRawTransaction failed: ${e.message}` };
      }

      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY sent", {
        symbol,
        signature,
      });

      // 8. Confirm using the SAME blockhash captured before send
      let confirmError: string | null = null;
      try {
        const status = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed"
        );
        if (status.value.err) {
          confirmError = `Transaction failed: ${status.value.err.toString()}`;
        }
      } catch (e: any) {
        confirmError = `confirmTransaction failed: ${e.message}`;
      }

      if (confirmError) {
        // Phase 2A: FAILED journal row
        await watchlistService.logTradeRow({
          clientOrderId: `buy-live:${mintAddress}:${signature}`,
          mint: mintAddress,
          symbol,
          side: "BUY",
          mode: "LIVE",
          solIn: tradeSize,
          txSig: signature,
          status: "FAILED",
          reason: confirmError,
        });
        return {
          success: false,
          txSignature: signature,
          error: confirmError,
        };
      }

      // Phase 2A: FILLED journal row
      await watchlistService.logTradeRow({
        clientOrderId: `buy-live:${mintAddress}:${signature}`,
        mint: mintAddress,
        symbol,
        side: "BUY",
        mode: "LIVE",
        solIn: tradeSize,
        solOut: 0,
        txSig: signature,
        status: "FILLED",
      });

      // 9. Reconcile ATA balance after confirmed buy
      try {
        const ataBalance = await this.getTokenBalance(connection, keypair.publicKey, mintAddress);
        if (ataBalance === null || ataBalance === 0) {
          logger.warn("EXECUTION", "TradeExecution", "RECONCILE_NEEDED", {
            symbol,
            mint: mintAddress,
            signature,
          });
        }
      } catch (e: any) {
        logger.warn("EXECUTION", "TradeExecution", "Post-buy balance check failed", {
          symbol,
          error: e.message,
        });
      }

      // 9. Open position in watchlist
      const entryPrice = await this.getTokenPrice(connection, mintAddress);
      // Derive price from quote if API returns 0
      let effectivePrice = entryPrice;
      if (entryPrice <= 0) {
        // SOL per token = inAmount (lamports) / outAmount (raw tokens)
        // Convert to SOL: divide lamports by 1e9
        const solSpent = Number(quoteResult.slim.inAmount) / 1e9;
        const tokensReceived = Number(quoteResult.slim.outAmount);
        if (tokensReceived > 0) {
          effectivePrice = solSpent / tokensReceived;
          logger.info("EXECUTION", "TradeExecution", "Derived entry price from quote", {
            symbol,
            solSpent,
            tokensReceived,
            derivedPrice: effectivePrice,
          });
        }
      }

      await watchlistService.addPosition(
        mintAddress,
        symbol,
        signature,
        effectivePrice,
        tradeSize
      );

      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY completed", {
        symbol,
        signature,
        convictionScore,
        triggerType,
      });

      return { success: true, txSignature: signature };
    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "[LIVE] BUY error", {
        symbol,
        error: e.message,
      });
      return { success: false, error: e.message || "Unknown error" };
    }
  }

  /**
   * Phase 1B: Token balance check for both Token and Token-2022 programs.
   */
  private async getTokenBalance(
    connection: Connection,
    owner: PublicKey,
    mint: string
  ): Promise<number | null> {
    const mintPubkey = new PublicKey(mint);

    // Use parsed accounts for both Token and Token-2022 to get raw amount (string integer)
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPubkey });
      if (tokenAccounts.value.length > 0) {
        const account = tokenAccounts.value[0];
        const tokenAmount = account.account.data.parsed.info.tokenAmount;
        // tokenAmount.amount is the raw integer amount as a string
        return Number(tokenAmount.amount);
      }
    } catch (e: any) {
      logger.warn("EXECUTION", "TradeExecution", "Token balance check failed", {
        mint,
        error: e.message,
      });
    }

    return null;
  }

  /**
   * Get token price from Jupiter Price API or DexScreener fallback.
   */
  private async getTokenPrice(connection: Connection, mint: string): Promise<number> {
    logger.info("EXECUTION", "TradeExecution", "Fetching token price", { mint });

    try {
      // Try Jupiter Price API
      const jupiterService = this.runtime?.getService?.("JUPITER_SERVICE");
      if (jupiterService && jupiterService.getTokenPrice) {
        const price = await jupiterService.getTokenPrice(mint);
        if (price > 0) return price;
      }

      // Fallback to DexScreener
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const pair = data?.pairs?.[0];
        if (pair && pair.priceUsd) {
          return parseFloat(pair.priceUsd);
        }
      }
    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "Error fetching token price", {
        mint,
        error: e.message,
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
      const cap = maxTradeSizeSol();
      const dynamicMultiplier = Math.min(1.25, Math.max(0.5, convictionScore));
      let tradeSize = parseFloat((baseTradeSize * dynamicMultiplier).toFixed(4));
      // Clamp to cap so no 1.25x overshoot
      if (tradeSize > cap) {
        tradeSize = cap;
      }

      // Risk cap checks
      const riskCheck = await checkBuyRisk(tradeSize);
      if (!riskCheck.ok) {
        logger.warn("EXECUTION", "TradeExecution", "Risk check failed", { symbol, reason: riskCheck.reason });
        return { success: false, error: `Risk check failed: ${riskCheck.reason}` };
      }

      const slippageBps = configService.getNumber("SLIPPAGE_BPS");
      // Phase 0F: env DRY_RUN=true must prevent live even if ConfigService is toggled
      const dryRun = isDryRun() || configService.getBoolean("DRY_RUN_MODE");

      if (dryRun) {
        // DRY-RUN: quote only. Never build swap tx, never send.
        const now = new Date();
        const clientOrderId = `buy:${mintAddress}:${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}`;
        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY starting", {
          symbol,
          convictionScore,
          tradeSize,
          clientOrderId,
        });

        // Jupiter breaker open? Refuse.
        if (jupiterBreakerOpen()) {
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] [breaker] jupiter OPEN", { symbol });
          return { success: false, error: "Jupiter circuit breaker is open", dryRun: true };
        }

        // Fetch real Jupiter quote (read-only)
        const inAmount = Math.round(tradeSize * 1e9);
        const quoteResult = await jupiterQuote(SOL_MINT, mintAddress, inAmount, slippageBps);
        if (!quoteResult) {
          tripJupiterBreaker();
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] BUY quote failed, not opening position", { symbol });
          return { success: false, error: "quote failed", dryRun: true };
        }
        resetJupiterBreaker();

        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY quoted", {
          symbol,
          in: quoteResult.slim.inAmount,
          out: quoteResult.slim.outAmount,
          priceImpact: quoteResult.slim.priceImpactPct,
        });

        const entryPrice = await this.getTokenPrice(this.getConnection(), mintAddress);
        // Derive price from quote if needed
        let effectivePrice = entryPrice;
        if (entryPrice <= 0) {
          const solSpent = Number(quoteResult.slim.inAmount) / 1e9;
          const tokensReceived = Number(quoteResult.slim.outAmount);
          if (tokensReceived > 0) {
            effectivePrice = solSpent / tokensReceived;
          }
        }

        const txSignature = "DRY_RUN_BUY_" + Date.now();
        await watchlistService.addPosition(mintAddress, symbol, txSignature, effectivePrice, tradeSize);
        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] BUY position opened (no tx sent)", {
          symbol,
          signature: txSignature,
        });

        // Phase 2A: PAPER BUY journal row (sol_in = tradeSize; sol_out = 0)
        await watchlistService.logTradeRow({
          clientOrderId: clientOrderId,
          mint: mintAddress,
          symbol,
          side: "BUY",
          mode: "DRY_RUN",
          solIn: tradeSize,
          solOut: 0,
          pxQuote: effectivePrice,
          txSig: txSignature,
          status: "PAPER",
          reason: "dry-run buy",
        });

        return { success: true, txSignature, dryRun: true };
      }

      // LIVE path
      logger.info("EXECUTION", "TradeExecution", "[LIVE] BUY executing", {
        symbol,
        convictionScore,
        tradeSize,
      });

      if (jupiterBreakerOpen()) {
        logger.warn("EXECUTION", "TradeExecution", "[LIVE] [breaker] jupiter OPEN", { symbol });
        return { success: false, error: "Jupiter circuit breaker is open" };
      }

      return await this.executeLiveBuy(mintAddress, symbol, convictionScore, tradeSize, triggerType);
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
        const sellMarkPrice = await this.getTokenPrice(this.getConnection(), mintAddress);
        if (sellMarkPrice <= 0) {
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] SELL mark price missing", { symbol });
        }

        // Phase 2A: look up position amount to compute sol_out for the PAPER row
        let solOut = 0;
        try {
          const openPositions = await watchlistService.getOpenPositions(true);
          const pos = openPositions.find(p => p.mint_address === mintAddress);
          if (pos && sellMarkPrice > 0) {
            solOut = pos.amount_sol * sellMarkPrice;
          }
        } catch (e: any) {
          logger.warn("EXECUTION", "TradeExecution", "[DRY_RUN] SELL sol_out calc failed", {
            symbol, error: e.message,
          });
        }

        logger.info("EXECUTION", "TradeExecution", "[DRY_RUN] SELL completed (no tx sent)", { symbol, reason, sellMarkPrice });
        const txSignature = "DRY_RUN_SELL_" + Date.now();

        // Phase 2A: PAPER SELL journal row
        await watchlistService.logTradeRow({
          clientOrderId: `sell:${mintAddress}:${txSignature}`,
          mint: mintAddress,
          symbol,
          side: "SELL",
          mode: "DRY_RUN",
          solOut,
          pxQuote: sellMarkPrice,
          txSig: txSignature,
          status: "PAPER",
          reason: "dry-run sell",
        });

        return { success: true, txSignature, dryRun: true };
      }

      // LIVE path
      logger.info("EXECUTION", "TradeExecution", "[LIVE] SELL executing", { symbol, reason });
      return await this.executeLiveSell(mintAddress, symbol, reason);
    } catch (e: any) {
      logger.error("EXECUTION", "TradeExecution", "Sell execution failed", { symbol, error: e.message });
      return { success: false, error: e.message };
    }
  }
}

export const tradeExecutionService = new TradeExecutionService(null);
export default tradeExecutionService;
