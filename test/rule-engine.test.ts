import { describe, test, expect } from "bun:test";
import { evaluateRules } from "../src/rules/engine.ts";
import type { Rule, RuleContext } from "../src/rules/engine.ts";

describe("rule engine", () => {
  test("timer rule fires when interval elapsed", () => {
    const rules: Rule[] = [
      { trigger: "timer", every_sec: 3600, action: "set_aside", params: { amount: 0.1 } },
    ];
    const context: RuleContext = {
      now: 100000,
      last_timer_fires: { set_aside: 60000 },
    };
    const actions = evaluateRules(rules, context);
    expect(actions.length).toBe(1);
    expect(actions[0].rule.action).toBe("set_aside");
    expect(actions[0].params?.amount).toBe(0.1);
  });

  test("timer rule does not fire when interval not elapsed", () => {
    const rules: Rule[] = [
      { trigger: "timer", every_sec: 15000, action: "set_aside" },
    ];
    const context: RuleContext = {
      now: 100000,
      last_timer_fires: { set_aside: 90000 },
    };
    const actions = evaluateRules(rules, context);
    expect(actions.length).toBe(0);
  });

  test("pnl rule fires above threshold", () => {
    const rules: Rule[] = [
      { trigger: "pnl", threshold: 100, action: "transfer" },
    ];
    const context: RuleContext = {
      now: 100000,
      pnl: 150,
    };
    const actions = evaluateRules(rules, context);
    expect(actions.length).toBe(1);
    expect(actions[0].rule.action).toBe("transfer");
  });

  test("pnl rule missing threshold fails closed", () => {
    const rules: Rule[] = [
      { trigger: "pnl", action: "transfer" },
    ];
    const context: RuleContext = {
      now: 100000,
      pnl: 150,
    };
    const actions = evaluateRules(rules, context);
    expect(actions.length).toBe(0);
  });

  test("multiple rules fire independently", () => {
    const rules: Rule[] = [
      { trigger: "timer", every_sec: 3600, action: "set_aside" },
      { trigger: "pnl", threshold: 50, action: "transfer" },
    ];
    const context: RuleContext = {
      now: 100000,
      last_timer_fires: { set_aside: 10000 },
      pnl: 200,
    };
    const actions = evaluateRules(rules, context);
    expect(actions.length).toBe(2);
  });
});
