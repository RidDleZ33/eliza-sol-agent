import { describe, test, expect } from "bun:test";
import { escapeHtml, TelegramDashboardFormatter } from "../src/utils/TelegramDashboardFormatter.ts";

describe("escapeHtml", () => {
  test("escapes ampersand, less-than, greater-than", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("does not double-escape", () => {
    expect(escapeHtml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });

  test("handles Gamma EMA veto text", () => {
    const reason = "HARD VETO (PA): Bearish EMA trend (9<21)";
    const escaped = escapeHtml(reason);
    expect(escaped).toContain("&lt;");
    expect(escaped).not.toContain("<21");
  });
});

describe("TelegramDashboardFormatter", () => {
  test("escapes reason in journal logs", () => {
    const metrics = {
      portfolio: {
        active_positions_count: 0,
        max_positions: 5,
        total_sol_deployed: 0,
        unrealized_pnl_sol: 0,
        realized_pnl_usd: 0,
        win_rate_pct: 0,
        total_trades_closed: 0,
      },
      positions: [],
      pipeline: {
        pending_alpha: 0,
        alpha_passed: 0,
        beta_passed: 0,
        evaluating: 0,
      },
      recent_journal: [
        {
          symbol: "EMPIRE",
          event_type: "exit",
          created_at: Date.now(),
          reason: "HARD VETO (PA): Bearish EMA trend (9<21)",
        },
      ],
    };

    const html = TelegramDashboardFormatter.formatDashboard(metrics as any);
    expect(html).toContain("&lt;21");
    expect(html).not.toContain("<21");
  });

  test("escapes symbol and event_type", () => {
    const metrics = {
      portfolio: {
        active_positions_count: 0,
        max_positions: 5,
        total_sol_deployed: 0,
        unrealized_pnl_sol: 0,
        realized_pnl_usd: 0,
        win_rate_pct: 0,
        total_trades_closed: 0,
      },
      positions: [],
      pipeline: {
        pending_alpha: 0,
        alpha_passed: 0,
        beta_passed: 0,
        evaluating: 0,
      },
      recent_journal: [
        {
          symbol: "A&B<C",
          event_type: "buy&sell",
          created_at: Date.now(),
          reason: null,
        },
      ],
    };

    const html = TelegramDashboardFormatter.formatDashboard(metrics as any);
    expect(html).toContain("A&amp;B&lt;C");
    expect(html).toContain("buy&amp;sell");
  });
});
