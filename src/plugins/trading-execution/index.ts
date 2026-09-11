import { Plugin, Action } from "@elizaos/core";
import { Connection } from "@solana/web3.js";
import { getGammaKeypair, createConnection } from "../../utils/wallet.ts";
import { env, isDryRun } from "../../utils/env.ts";

interface JupiterService {
  getQuote(params: any): Promise<any>;
  executeSwap(params: any): Promise<any>;
  confirmTransaction(conn: Connection, sig: string): Promise<boolean>;
}

export const tradingExecutionPlugin: Plugin = {
  name: "trading-execution",
  description: "Gamma's exclusive Jupiter/Jito trading execution plugin",
  init: async (runtime) => {
    console.log("trading-execution plugin initialized");
  },
  actions: [
    {
      name: "execute_trade",
      description: "Execute a Jupiter swap via Jito bundles (Gamma only)",
      parameters: {
        type: "object",
        properties: {
          input_mint: { type: "string" },
          output_mint: { type: "string" },
          amount_sol: { type: "number" },
        },
      },
      examples: [
        {
          user: "Execute trade: swap 0.5 SOL for PEPE",
          assistant:
            "Trade executed via Jupiter. Transaction confirmed on-chain.",
        },
      ],
      validate: async (runtime, message, parameters) => {
        return parameters.input_mint &&
          parameters.output_mint &&
          parameters.amount_sol > 0;
      },
      handler: async (runtime, message, parameters) => {
        runtime.logger.info(
          `Gamma executing trade: ${parameters.amount_sol} SOL -> ${parameters.output_mint}`
        );

        if (isDryRun()) {
          console.log(`[DRY RUN] swap ${parameters.amount_sol} SOL -> ${parameters.output_mint}`);
          return "Trade simulated in dry-run mode. No on-chain transaction sent.";
        }

        const keypair = getGammaKeypair();
        if (!keypair) {
          return "Execution failed: GAMMA_PRIVATE_KEY not configured.";
        }

        const jupiterService = runtime.getService("JUPITER_SERVICE") as JupiterService;
        if (!jupiterService) {
          return "Execution failed: Jupiter service not available.";
        }

        const connection = createConnection();
        const slippageBps = env.SLIPPAGE_BPS ? parseInt(env.SLIPPAGE_BPS) : 50;

        try {
          const quote = await jupiterService.getQuote({
            inputMint: parameters.input_mint,
            outputMint: parameters.output_mint,
            amount: parameters.amount_sol,
            slippageBps,
          });

          if (!quote || !quote.outAmount) {
            return "Execution failed: No quote returned from Jupiter.";
          }

          const swapResult = await jupiterService.executeSwap({
            quoteResponse: quote,
            userPublicKey: keypair.publicKey.toBase58(),
            slippageBps,
          });

          if (!swapResult || !swapResult.tx) {
            return "Execution failed: No transaction returned from Jupiter.";
          }

          // Decode and sign
          const transaction = Buffer.from(swapResult.tx, "base64");
          const decoded = await jupiterService.deserializeTransaction(transaction);
          decoded.sign([keypair]);

          // Send
          const txId = await connection.sendTransaction(decoded);
          const confirmed = await jupiterService.confirmTransaction(connection, txId);

          if (confirmed) {
            runtime.logger.info(`Trade executed. TX: ${txId}`);
            return `Trade executed. TX: ${txId}`;
          } else {
            runtime.logger.warn(`Trade sent but not confirmed. TX: ${txId}`);
            return `Trade sent but not confirmed. TX: ${txId}`;
          }
        } catch (e: any) {
          runtime.logger.error(`Trade execution failed: ${e.message}`);
          return `Trade failed: ${e.message}`;
        }
      },
    },
    {
      name: "get_price",
      description: "Get current token price from Jupiter",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
        },
      },
      examples: [
        {
          user: "Get price of PEPE",
          assistant: "PEPE is currently trading at $0.001234 per token.",
        },
      ],
      handler: async (runtime, message, parameters) => {
        const jupiterService = runtime.getService("JUPITER_SERVICE") as JupiterService;
        if (!jupiterService) {
          return "Price lookup failed: Jupiter service not available.";
        }

        try {
          const price = await jupiterService.getTokenPrice(parameters.mint);
          return `${parameters.mint} is trading at $${price.toFixed(8)} per token.`;
        } catch (e: any) {
          return `Price lookup failed: ${e.message}`;
        }
      },
    },
  ],
};
