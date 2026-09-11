import { Plugin, Action, Evaluator } from "@elizaos/core";
import { TradeSignalSchema } from "../../types/consensus.ts";

let signals = [];

export const consensusPlugin: Plugin = {
  name: "consensus-room",
  description: "Shared memory room for AI Committee signal ingestion and consensus evaluation",

  actions: [
    {
      name: "ingest_signal",
      description: "Ingest a trade signal from Alpha or Beta into the shared room",
      parameters: {
        type: "object",
        properties: {
          sender: { type: "string" },
          role: { type: "string", enum: ["alpha", "beta"] },
          content: { type: "string" },
          signal: { type: "object" },
        },
      },
      examples: [
        {
          user: "Ingest signal from Alpha about PEPE",
          assistant: "Signal recorded in consensus room.",
        },
      ],
      handler: async (runtime, message) => {
        const msg = JSON.parse(message.content);
        const validated = TradeSignalSchema.safeParse(msg.signal);
        if (validated.success) {
          signals.push({
            sender: msg.sender,
            role: msg.role,
            content: msg.content,
            timestamp: Date.now(),
            signal: validated.data,
          });
        }
        return "Signal ingested into consensus room.";
      },
    },
    {
      name: "check_consensus",
      description: "Evaluate whether consensus has been reached for a trade",
      parameters: {
        type: "object",
        properties: {
          mint: { type: "string" },
        },
      },
      examples: [
        {
          user: "Check consensus for mint ABC123",
          assistant: "Consensus reached: Alpha narrative 0.85, Beta risk PASS.",
        },
      ],
      handler: async (runtime, message) => {
        const msg = JSON.parse(message.content);
        const mint = msg.mint;
        const relevant = signals.filter(
          (s) => s.signal && s.signal.token_mint === mint
        );
        const alpha = relevant.find((s) => s.role === "alpha");
        const beta = relevant.find((s) => s.role === "beta");

        if (!alpha || !beta) {
          return "Consensus not reached: missing Alpha or Beta signal.";
        }

        if (
          alpha.signal.narrative_confidence >= 0.75 &&
          beta.signal.risk_score_acceptable
        ) {
          return `Consensus reached for ${mint}: Alpha ${alpha.signal.narrative_confidence}, Beta risk ACCEPTED.`;
        }
        return "Consensus not reached. Alpha or Beta criteria unmet.";
      },
    },
  ],

  evaluators: [
    {
      name: "evaluate_consensus",
      description: "Background evaluator that checks for new consensus opportunities",
      intervalMs: 5000,
      handler: async (runtime) => {
        const mintsWithBoth = new Set<string>();
        for (const s of signals) {
          if (s.signal && s.signal.token_mint) {
            mintsWithBoth.add(s.signal.token_mint);
          }
        }
        for (const mint of mintsWithBoth) {
          const relevant = signals.filter(
            (s) => s.signal && s.signal.token_mint === mint
          );
          const alpha = relevant.find((s) => s.role === "alpha");
          const beta = relevant.find((s) => s.role === "beta");
          if (
            alpha &&
            beta &&
            alpha.signal.narrative_confidence >= 0.75 &&
            beta.signal.risk_score_acceptable
          ) {
            runtime.logger.info(`Consensus detected for ${mint} — notifying Gamma`);
            runtime.emitEvent("consensus_reached", { mint });
          }
        }
      },
    },
  ],
};
