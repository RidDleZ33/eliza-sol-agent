import { telegramAdminBot } from "./TelegramAdminBot.ts";
import { logger } from "./LoggerService.ts";

export type WarRoomAgent = "ALPHA" | "BETA" | "GAMMA";
export type WarRoomEvent =
  | "SIGNAL_DETECTED"
  | "ANALYSIS_COMPLETE"
  | "VOTE_CAST"
  | "CONSENSUS_REACHED"
  | "DISAGREEMENT"
  | "TRADE_EXECUTED"
  | "RISK_ASSESSMENT"
  | "POST_MORTEM"
  | "CUSTOM";

export interface WarRoomMessage {
  agent: WarRoomAgent;
  event: WarRoomEvent;
  details?: any;
}

/**
 * Post an inter-agent war room / committee message.
 * Saves to DB (future) and streams to Telegram if war room streaming is enabled.
 */
export async function postWarRoomMessage(
  agent: WarRoomAgent,
  event: WarRoomEvent,
  details?: any
): Promise<void> {
  // Future: save to SQLite war_room table
  // await db.insertIntoWarRoom(agent, event, details);

  // Stream to Telegram if enabled
  await telegramAdminBot.streamWarRoomMessage(agent, event, details);

  // Always log locally
  logger.info("SOCIAL", "WarRoomService", `${agent} ${event}`, details);
}

/**
 * Convenience: cast a vote in the war room
 */
export async function warRoomVote(
  agent: WarRoomAgent,
  symbol: string,
  decision: "BUY" | "SELL" | "HOLD",
  confidence: number,
  reasoning?: string
): Promise<void> {
  await postWarRoomMessage(agent, "VOTE_CAST", {
    symbol,
    decision,
    confidence,
    reasoning
  });
}

/**
 * Convenience: post a consensus result
 */
export async function warRoomConsensus(
  symbol: string,
  decision: "BUY" | "SELL" | "HOLD",
  votes: Record<WarRoomAgent, "BUY" | "SELL" | "HOLD">
): Promise<void> {
  await postWarRoomMessage("ALPHA", "CONSENSUS_REACHED", {
    symbol,
    decision,
    votes
  });
}
