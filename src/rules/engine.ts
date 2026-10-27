// Rule engine skeleton.
// evaluateRules() returns the list of actions that would fire. No side effects.
// Rules are stored in compiled config; execution is deferred to future phases.

export interface Rule {
  trigger: "timer" | "pnl" | "wallet_size";
  every_sec?: number;
  threshold?: number;
  action: "set_aside" | "transfer" | "resize" | "pause";
  params?: Record<string, any>;
}

export interface RuleContext {
  now: number;
  pnl?: number;
  wallet_size?: number;
  last_timer_fires?: Record<string, number>;
}

export interface FiringAction {
  rule: Rule;
  reason: string;
  params?: Record<string, any>;
}

export function evaluateRules(rules: Rule[], context: RuleContext): FiringAction[] {
  const actions: FiringAction[] = [];

  for (const rule of rules) {
    if (rule.trigger === "timer") {
      if (rule.every_sec === undefined || rule.every_sec <= 0) {
        continue; // missing interval fails closed
      }
      const lastFire = context.last_timer_fires?.[rule.action] || 0;
      const elapsed = context.now - lastFire;
      if (elapsed >= rule.every_sec) {
        actions.push({
          rule,
          reason: `timer elapsed ${elapsed}s >= ${rule.every_sec}s`,
          params: rule.params,
        });
      }
    }

    if (rule.trigger === "pnl") {
      if (rule.threshold === undefined || context.pnl === undefined) {
        continue; // missing threshold or value fails closed
      }
      if (context.pnl >= rule.threshold) {
        actions.push({
          rule,
          reason: `pnl ${context.pnl} >= threshold ${rule.threshold}`,
          params: rule.params,
        });
      }
    }

    if (rule.trigger === "wallet_size") {
      if (rule.threshold === undefined || context.wallet_size === undefined) {
        continue; // missing threshold or value fails closed
      }
      if (context.wallet_size >= rule.threshold) {
        actions.push({
          rule,
          reason: `wallet_size ${context.wallet_size} >= threshold ${rule.threshold}`,
          params: rule.params,
        });
      }
    }
  }

  return actions;
}
