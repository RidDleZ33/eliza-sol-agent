import { z } from "zod";

export const TradeSignalSchema = z.object({
  token_mint: z.string(),
  narrative_momentum: z.boolean(),
  liquidity_verified: z.boolean(),
  risk_score_acceptable: z.boolean(),
  narrative_confidence: z.number().min(0).max(1),
  liquidity_locked: z.boolean().optional(),
  top10_concentration: z.number().optional(),
  mint_disabled: z.boolean().optional(),
  risk_code: z.string().optional(),
});

export type TradeSignal = z.infer<typeof TradeSignalSchema>;

export interface AgentMessage {
  sender: string;
  role: "alpha" | "beta" | "gamma";
  content: string;
  timestamp: number;
  signal?: TradeSignal;
}
