import type { DashboardMetrics } from "../services/WatchlistService.ts";

export class TelegramDashboardFormatter {
  /**
   * Formats Dashboard Metrics into Telegram HTML
   */
  static formatDashboard(metrics: DashboardMetrics): string {
    const { portfolio, positions, pipeline, recent_journal } = metrics;

    const pnlEmoji = portfolio.unrealized_pnl_usd >= 0 ? "🟢" : "🔴";
    const realizedEmoji = portfolio.realized_pnl_usd >= 0 ? "💰" : "📉";

    let html = `<b>📊 AUTONOMOUS TRADING ENGINE DASHBOARD</b>\n`;
    html += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // 1. Portfolio Summary
    html += `<b>💼 PORTFOLIO OVERVIEW</b>\n`;
    html += `• <b>Active Positions:</b> ${portfolio.active_positions_count} / ${portfolio.max_positions}\n`;
    html += `• <b>Capital Deployed:</b> <code>${portfolio.total_sol_deployed} SOL</code>\n`;
    html += `• <b>Unrealized PnL:</b> ${pnlEmoji} <code>$${portfolio.unrealized_pnl_usd.toFixed(2)}</code>\n`;
    html += `• <b>Realized PnL:</b> ${realizedEmoji} <code>$${portfolio.realized_pnl_usd.toFixed(2)}</code>\n`;
    html += `• <b>Win Rate:</b> <code>${portfolio.win_rate_pct}%</code> (${portfolio.total_trades_closed} closed)\n\n`;

    // 2. Active Positions Detail
    html += `<b>🎯 ACTIVE OPEN POSITIONS</b>\n`;
    if (positions.length === 0) {
      html += `<i>No active positions. Engine scanning market pipeline...</i>\n\n`;
    } else {
      positions.forEach((pos, idx) => {
        const posPnlEmoji = pos.unrealized_pnl_pct >= 0 ? "📈" : "📉";
        const shortenedMint = `${pos.mint_address.slice(0, 4)}...${pos.mint_address.slice(-4)}`;

        html += `<b>${idx + 1}. $${pos.symbol}</b> (<code>${shortenedMint}</code>)\n`;
        html += `  • <b>Size:</b> <code>${pos.amount_sol} SOL</code>\n`;
        html += `  • <b>Entry $ :</b> <code>$${pos.entry_price_usd.toFixed(6)}</code>\n`;
        html += `  • <b>Current $:</b> <code>$${pos.current_price_usd.toFixed(6)}</code>\n`;
        html += `  • <b>Peak High $:</b> <code>$${pos.peak_price_usd.toFixed(6)}</code>\n`;
        html += `  • <b>PnL:</b> ${posPnlEmoji} <b>${pos.unrealized_pnl_pct.toFixed(2)}%</b> (<code>$${pos.unrealized_pnl_usd.toFixed(2)}</code>)\n`;
        html += `  • <b>Trailing SL:</b> <code>$${pos.trailing_stop_level_usd.toFixed(6)}</code>\n`;
        html += `  • <b>Tier:</b> <code>${pos.trailing_tier}</code>\n\n`;
      });
    }

    // 3. Pipeline Metrics
    html += `<b>🔍 COMMITTEE PIPELINE STATUS</b>\n`;
    html += `• <b>Pending Alpha:</b> <code>${pipeline.pending_alpha}</code> | <b>Alpha Passed:</b> <code>${pipeline.alpha_passed}</code>\n`;
    html += `• <b>Beta Passed:</b> <code>${pipeline.beta_passed}</code> | <b>Gamma Active:</b> <code>${pipeline.evaluating}</code>\n\n`;

    // 4. Recent Journal Logs
    html += `<b>📜 RECENT TRADE JOURNAL LOGS</b>\n`;
    if (!recent_journal || recent_journal.length === 0) {
      html += `<i>No journal logs recorded yet.</i>\n`;
    } else {
      recent_journal.forEach((log) => {
        const time = new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += `• <code>[${time}]</code> <b>${log.symbol}</b> - <b>${log.event_type}</b>\n`;
        if (log.reason) html += `  <i>Reason: ${log.reason}</i>\n`;
      });
    }

    return html;
  }
}
