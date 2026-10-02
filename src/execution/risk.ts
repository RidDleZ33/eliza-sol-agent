// Phase 1C: Risk caps and circuit breakers.
// Import from env.ts for env values.

import { logger } from "../services/LoggerService.ts";
import { telegramAdminBot } from "../services/TelegramAdminBot.ts";
import { watchlistService } from "../services/WatchlistService.ts";
import { getMaxTradeSizeSol, getMaxDeployedSol, getMaxDailyLossSol, getKillSwitch } from "../utils/env.ts";

// ---- Circuit breaker (simple state machine) ----
type BreakerState = "closed" | "open" | "half-open";

interface Breaker {
  state: BreakerState;
  failures: number;
  lastFailureMs: number;
}

function newBreaker(): Breaker {
  return { state: "closed", failures: 0, lastFailureMs: 0 };
}

const jupiterBreaker = newBreaker();
const rpcBreaker = newBreaker();
const dexscreenerBreaker = newBreaker();

const BREAKER_THRESHOLD = 3;
const BREAKER_TIMEOUT_MS = 15000;

function breakerOpen(b: Breaker): boolean {
  if (b.state === "open" && Date.now() - b.lastFailureMs < BREAKER_TIMEOUT_MS) {
    return true;
  }
  if (b.state === "open") {
    b.state = "half-open";
  }
  return false;
}

function breakerTrip(b: Breaker, name: string): void {
  b.failures++;
  b.lastFailureMs = Date.now();
  if (b.failures >= BREAKER_THRESHOLD && b.state !== "open") {
    b.state = "open";
    logger.warn("BREAKER", name, `[breaker] ${name} OPEN`);
  }
}

function breakerReset(b: Breaker): void {
  b.failures = 0;
  b.state = "closed";
}

// ---- Risk cap helpers ----
const sessionRealizedPnl = { value: 0.0 };

// Phase 12C: daily-loss halt notification throttle
let lastHaltNotifyMs = 0;
const HALT_NOTIFY_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes

function triggerDailyLossHaltNotify() {
  const now = Date.now();
  if (now - lastHaltNotifyMs < HALT_NOTIFY_THROTTLE_MS) {
    return; // still within throttle window
  }
  lastHaltNotifyMs = now;
  const pnl = sessionRealizedPnl.value.toFixed(2);
  const limit = (-maxDailyLossSol()).toFixed(2);
  const msg = `HALT daily-loss pnl=${pnl} limit=${limit} — buys blocked`;
  logger.warn("RISK", "TradeExecution", msg);
  telegramAdminBot.notifyAdmin(msg).catch(() => {});
  telegramAdminBot.sendToChat(msg).catch(() => {});
  watchlistService.logTradeJournal({
    mint_address: "HALT",
    symbol: "HALT",
    event_type: "BUY_FAILED",
    reason: msg,
  }).catch(() => {});
}

export function addSessionPnl(pnl: number): void {
  sessionRealizedPnl.value += pnl;
}

export function getSessionPnl(): number {
  return sessionRealizedPnl.value;
}

export function resetSessionPnl(): void {
  sessionRealizedPnl.value = 0.0;
}

export async function getOpenPositionSol(): Promise<number> {
  const positions = await watchlistService.getActivePositions();
  let total = 0.0;
  for (const p of positions) {
    total += (p as any).amount_sol ?? 0.0;
  }
  return total;
}

function getEnvNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = parseFloat(raw);
  return isNaN(n) ? fallback : n;
}

export function maxTradeSizeSol(): number {
  return getMaxTradeSizeSol();
}

export function maxDeployedSol(): number {
  return getMaxDeployedSol();
}

export function maxDailyLossSol(): number {
  return getMaxDailyLossSol();
}

export function killSwitchOn(): boolean {
  return getKillSwitch();
}

export interface RiskCheckResult {
  ok: boolean;
  reason: string;
  halt?: boolean; // true if this is a daily-loss halt (phase 12C)
}

export async function checkBuyRisk(tradeSize: number): Promise<RiskCheckResult> {
  if (tradeSize > maxTradeSizeSol()) {
    return { ok: false, reason: `trade size ${tradeSize} > MAX_TRADE_SIZE_SOL ${maxTradeSizeSol()}` };
  }

  const deployed = await getOpenPositionSol();
  if (deployed + tradeSize > maxDeployedSol()) {
    return { ok: false, reason: `deployed ${deployed} + ${tradeSize} > MAX_DEPLOYED_SOL ${maxDeployedSol()}` };
  }

  if (killSwitchOn()) {
    return { ok: false, reason: "KILL_SWITCH is on" };
  }

  if (sessionRealizedPnl.value <= -maxDailyLossSol()) {
    const reason = `session pnl ${sessionRealizedPnl.value} <= -MAX_DAILY_LOSS_SOL ${maxDailyLossSol()}`;
    triggerDailyLossHaltNotify();
    return { ok: false, reason, halt: true };
  }

  return { ok: true, reason: "ok" };
}

export function jupiterBreakerOpen(): boolean {
  return breakerOpen(jupiterBreaker);
}

export function tripJupiterBreaker(): void {
  breakerTrip(jupiterBreaker, "jupiter");
}

export function resetJupiterBreaker(): void {
  breakerReset(jupiterBreaker);
}

export function rpcBreakerOpen(): boolean {
  return breakerOpen(rpcBreaker);
}

export function tripRpcBreaker(): void {
  breakerTrip(rpcBreaker, "rpc");
}

export function resetRpcBreaker(): void {
  breakerReset(rpcBreaker);
}

export function dexscreenerBreakerOpen(): boolean {
  return breakerOpen(dexscreenerBreaker);
}

export function tripDexscreenerBreaker(): void {
  breakerTrip(dexscreenerBreaker, "dexscreener");
}

export function resetDexscreenerBreaker(): void {
  breakerReset(dexscreenerBreaker);
}
