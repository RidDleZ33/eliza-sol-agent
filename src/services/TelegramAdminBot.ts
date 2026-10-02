import { Telegraf, Markup } from "telegraf";
import { PublicKey } from "@solana/web3.js";
import { configService, ConfigKey } from "./ConfigService.ts";
import { logger, LogLevel } from "./LoggerService.ts";
import { watchlistService } from "./WatchlistService.ts";
import { aggregateBook } from "./TradeBookService.ts";
import { resetSessionPnl } from "../execution/risk.ts";
import { TelegramDashboardFormatter } from "../utils/TelegramDashboardFormatter.ts";
import { tier, can } from "../entitlements/tier.ts";

const ADMIN_BOT_VERSION = "2.4.0";

const LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR", "SILENT"];
const LOG_CATEGORIES = [
  "INGESTION", "EXECUTION", "POSITIONS", "TELEGRAM", "WATCHLIST",
  "FORENSICS", "SOCIAL", "CIRCUIT_BREAKER", "CONFIG", "CRASH_RECOVERY", "DEX"
];

function escapeMd(text: string): string {
  return String(text).replace(/([*_\[\]()~`>#+|=!])/g, "\\$1");
}

export class TelegramAdminBot {
  private bot: Telegraf<any> | null = null;
  private adminChatId: string;
  private started = false;

  // Log streaming state
  private logStreamEnabled = false;
  private logStreamPaused = false;
  private logStreamPauseTimer: any = null;
  private readonly LOG_STREAM_PAUSE_DURATION = 30000; // 30 seconds

  // War room streaming state
  private warRoomEnabled = false;
  private warRoomPaused = false;
  private warRoomPauseTimer: any = null;
  private readonly WAR_ROOM_PAUSE_DURATION = 30000; // 30 seconds

  constructor() {
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
    // Token is checked in start(); don't build Telegraf with empty token here.
  }

  private isAdmin(ctx: any): boolean {
    const adminIds = [process.env.TELEGRAM_ADMIN_CHAT_ID, process.env.TELEGRAM_TELEMETRY_CHAT_ID]
      .filter((id) => id && id.length > 0);
    const fromId = String(ctx.from?.id ?? "");
    const chatId = String(ctx.chat?.id ?? "");
    return adminIds.includes(fromId) || adminIds.includes(chatId);
  }

  private pauseLogStream() {
    if (!this.logStreamEnabled) return;
    this.logStreamPaused = true;
    clearTimeout(this.logStreamPauseTimer);
    this.logStreamPauseTimer = setTimeout(() => {
      this.logStreamPaused = false;
    }, this.LOG_STREAM_PAUSE_DURATION);
  }

  private pauseWarRoom() {
    if (!this.warRoomEnabled) return;
    this.warRoomPaused = true;
    clearTimeout(this.warRoomPauseTimer);
    this.warRoomPauseTimer = setTimeout(() => {
      this.warRoomPaused = false;
    }, this.WAR_ROOM_PAUSE_DURATION);
  }

  private registerCommands() {
    this.bot.command(["settings", "config"], async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      
      const args = ctx.args;
      if (args && args.length > 0 && args[0].toLowerCase() === "list") {
        await this.showSettingsList(ctx);
      } else {
        await this.showMainMenu(ctx);
      }
    });

    this.bot.command("set", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      const args = ctx.args;
      if (!args || args.length < 2) {
        await ctx.reply(
          "Usage: /set <KEY> <VALUE>\n\n" +
          "See /settings list for available settings.\n" +
          "Examples:\n" +
          "  /set TAKE_PROFIT_PCT 75\n" +
          "  /set STOP_LOSS_PCT 25\n" +
          "  /set MAX_TRADE_SIZE_SOL 1.5"
        );
        return;
      }
      const key = args[0].toUpperCase() as ConfigKey;
      const value = args[1];
      try {
        await configService.set(key, value);
        logger.info("CONFIG", "TelegramAdminBot", "Config updated via Telegram", { key, value });
        await ctx.reply(`✅ Updated ${key} = ${value}`);
      } catch (e) {
        logger.error("CONFIG", "TelegramAdminBot", "Failed to update config", { key, error: e.message });
        await ctx.reply(`❌ Failed: ${e.message}`);
      }
    });

    this.bot.command("toggle", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      const args = ctx.args;
      if (!args || args.length < 1) {
        await ctx.reply("Usage: /toggle <KEY>\nExample: /toggle DRY_RUN_MODE");
        return;
      }
      const key = args[0].toUpperCase() as ConfigKey;
      try {
        await configService.toggle(key);
        const newValue = configService.get(key);
        logger.info("CONFIG", "TelegramAdminBot", "Config toggled", { key, value: newValue });
        await ctx.reply(`✅ Toggled ${key} = ${newValue}`);
      } catch (e) {
        logger.error("CONFIG", "TelegramAdminBot", "Failed to toggle", { key, error: e.message });
        await ctx.reply(`❌ Failed: ${e.message}`);
      }
    });

    this.bot.command("trades", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      if (!can("view_trades")) {
        await ctx.reply(`⚠️ tier ${tier()} too low for trade journal`);
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showTradeJournal(ctx);
    });

    this.bot.command("gamma", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showGamma(ctx);
    });

    this.bot.command("pnl", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      if (!can("view_trades")) {
        await ctx.reply(`⚠️ tier ${tier()} too low for pnl`);
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showPnl(ctx);
    });

    this.bot.command("book", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      if (!can("view_trades")) {
        await ctx.reply(`⚠️ tier ${tier()} too low for trade journal`);
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showBook(ctx);
    });

    this.bot.command("dashboard", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showDashboard(ctx);
    });

    this.bot.command("positions", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showPositions(ctx);
    });

    this.bot.command("status", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showDashboard(ctx);
    });

    this.bot.command("logs", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showLogMenu(ctx);
    });

    this.bot.command("logstream", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      const args = ctx.args;
      if (!args || args.length < 1) {
        await ctx.reply(`Usage: /logstream <on|off|status>\nCurrent: ${this.logStreamEnabled ? "ON" : "OFF"}`);
        return;
      }
      const action = args[0].toLowerCase();
      if (action === "on") {
        this.logStreamEnabled = true;
        logger.info("TELEGRAM", "TelegramAdminBot", "Log streaming enabled");
        await ctx.reply("✅ Log streaming to chat enabled.");
      } else if (action === "off") {
        this.logStreamEnabled = false;
        logger.info("TELEGRAM", "TelegramAdminBot", "Log streaming disabled");
        await ctx.reply("✅ Log streaming to chat disabled.");
      } else if (action === "status") {
        await ctx.reply(`Log streaming: ${this.logStreamEnabled ? "ON" : "OFF"}`);
      } else {
        await ctx.reply("Usage: /logstream <on|off|status>");
      }
    });

    this.bot.command("cleardb", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      
      if (!ctx.args || ctx.args.length < 1 || ctx.args[0] !== "yes") {
        await ctx.reply("⚠️ This will clear all watched tokens, traders, positions, trade journal, and book.\nType /cleardb yes to confirm.");
        return;
      }
      
      try {
        const db = watchlistService.getDb();
        const wt = db.prepare("DELETE FROM watched_tokens").run();
        const wtr = db.prepare("DELETE FROM watched_traders").run();
        const pos = db.prepare("DELETE FROM positions").run();
        const tr = db.prepare("DELETE FROM trades").run();
        const tj = db.prepare("DELETE FROM trade_journal").run();
        resetSessionPnl();
        
        logger.info("TELEGRAM", "TelegramAdminBot", "Database cleared via admin command");
        await ctx.reply(`✅ Database cleared: ${wt.changes} watched_tokens, ${wtr.changes} watched_traders, ${pos.changes} positions, ${tr.changes} trades, ${tj.changes} journal entries. Session PnL reset. Fresh start.`);
      } catch (e) {
        logger.error("TELEGRAM", "TelegramAdminBot", "Failed to clear database", { error: e.message });
        await ctx.reply(`❌ Failed: ${e.message}`);
      }
    });

    this.bot.command("warroom", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      const args = ctx.args;
      if (!args || args.length < 1) {
        await ctx.reply(`Usage: /warroom <on|off|status>\nCurrent: ${this.warRoomEnabled ? "ON" : "OFF"}`);
        return;
      }
      const action = args[0].toLowerCase();
      if (action === "on") {
        this.warRoomEnabled = true;
        logger.info("TELEGRAM", "TelegramAdminBot", "War room streaming enabled");
        await ctx.reply("✅ War room (committee) streaming to chat enabled.");
      } else if (action === "off") {
        this.warRoomEnabled = false;
        logger.info("TELEGRAM", "TelegramAdminBot", "War room streaming disabled");
        await ctx.reply("✅ War room streaming to chat disabled.");
      } else if (action === "status") {
        await ctx.reply(`War room streaming: ${this.warRoomEnabled ? "ON" : "OFF"}`);
      } else {
        await ctx.reply("Usage: /warroom <on|off|status>");
      }
    });

    this.bot.command("loglevel", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      const args = ctx.args;
      if (!args || args.length < 1) {
        await ctx.reply("Usage: /loglevel <LEVEL>\nLevels: DEBUG, INFO, WARN, ERROR, SILENT");
        return;
      }
      const level = args[0].toUpperCase() as LogLevel;
      if (!LOG_LEVELS.includes(level)) {
        await ctx.reply(`❌ Invalid level. Use: ${LOG_LEVELS.join(", ")}`);
        return;
      }
      logger.setGlobalLogLevel(level);
      logger.info("TELEGRAM", "TelegramAdminBot", "Global log level set", { level });
      await ctx.reply(`✅ Global log level set to ${level}`);
    });

    this.bot.command("logcategory", async (ctx) => {
      if (!this.isAdmin(ctx)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      const args = ctx.args;
      if (!args || args.length < 2) {
        await ctx.reply(`Usage: /logcategory <CATEGORY> <LEVEL>\nCategories: ${LOG_CATEGORIES.join(", ")}\nLevels: ${LOG_LEVELS.join(", ")}`);
        return;
      }
      const category = args[0].toUpperCase();
      const level = args[1].toUpperCase() as LogLevel;
      if (!LOG_LEVELS.includes(level)) {
        await ctx.reply(`❌ Invalid level. Use: ${LOG_LEVELS.join(", ")}`);
        return;
      }
      try {
        logger.setCategoryLogLevel(category as any, level);
        logger.info("TELEGRAM", "TelegramAdminBot", "Category log level set", { category, level });
        await ctx.reply(`✅ ${category} set to ${level}`);
      } catch (e) {
        await ctx.reply(`❌ Failed: ${e.message}`);
      }
    });

    // Phase 9C: /start handler (Telegram Start button sends /start)
    this.bot.start(async (ctx) => {
      await ctx.reply(
        "🤖 Swarm Admin Bot\n\n" +
        "Type /help for commands.\n" +
        "Type /settings to configure."
      );
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "🤖 Swarm Admin Bot\n\n" +
        "Type /help for commands.\n" +
        "Type /settings to configure."
      );
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        "🤖 Swarm Admin Commands\n\n" +
        "📋 Management:\n" +
        "/settings - Main configuration menu\n" +
        "/settings list - View all available settings\n" +
        "/status - Live portfolio dashboard\n" +
        "/dashboard - Live portfolio dashboard (same as /status)\n" +
        "/positions - Detailed active position list\n" +
        "/trades - Trade journal and state\n" +
        "/pnl - Session PnL and position count\n" +
        "/book [24h] - Closed round-trip book sliced by exit/pa/src/hold\n" +
        "/gamma [SYMBOL] - Gamma consensus snapshots (last 8 or specific token)\n" +
        "/logs - Logging configuration\n" +
        "\n" +
        "📡 Streaming:\n" +
        "/logstream on|off|status - Stream agent logs to chat\n" +
        "/warroom on|off|status - Stream committee conversations to chat\n" +
        "\n" +
        "🔧 Debug:\n" +
        "/cleardb yes - Clear all watchlists and positions\n" +
        "\n" +
        "⚙️ Config:\n" +
        "/set KEY VALUE - Update a setting (see /settings list)\n" +
        "/toggle KEY - Toggle boolean value\n" +
        "/loglevel LEVEL - Set global log level\n" +
        "/logcategory CAT LEVEL - Set category log level"
      );
    });
  }

  private registerCallbacks() {
    this.bot.on("callback_query", async (ctx) => {
      const query = ctx.callbackQuery;
      if (!query) return;
      
      try {
        logger.debug("TELEGRAM", "TelegramAdminBot", "Callback received", { data: query.data });

        if (query.data === "toggle_dry_run") {
          await configService.toggle("DRY_RUN_MODE");
          const value = configService.getBoolean("DRY_RUN_MODE");
          logger.info("TELEGRAM", "TelegramAdminBot", "DRY_RUN_MODE toggled", { value });
          await ctx.answerCbQuery(`DRY_RUN: ${value ? "ON" : "OFF"}`);
          return;
        }

        if (query.data === "show_status") {
          await ctx.answerCbQuery();
          await this.showDashboard(ctx);
          return;
        }

        if (query.data === "log_menu") {
          await ctx.answerCbQuery();
          await this.showLogMenu(ctx);
          return;
        }

        if (query.data.startsWith("log_global_")) {
          const level = query.data.replace("log_global_", "").toUpperCase() as LogLevel;
          logger.setGlobalLogLevel(level);
          logger.info("TELEGRAM", "TelegramAdminBot", "Global log level set via button", { level });
          await ctx.answerCbQuery(`Global log level: ${level}`);
          await this.showLogMenu(ctx);
          return;
        }

        if (query.data.startsWith("log_cat_")) {
          const parts = query.data.replace("log_cat_", "").split(":");
          const category = parts[0].toUpperCase();
          const level = parts[1].toUpperCase() as LogLevel;
          logger.setCategoryLogLevel(category as any, level);
          logger.info("TELEGRAM", "TelegramAdminBot", "Category log level set via button", { category, level });
          await ctx.answerCbQuery(`${category}: ${level}`);
          return;
        }

        if (query.data === "exits") {
          await ctx.answerCbQuery();
          await ctx.reply(
            "💰 Exit Rules\n" +
            `• Take Profit: ${configService.getNumber("TAKE_PROFIT_PCT")}%\n` +
            `• Stop Loss: ${configService.getNumber("STOP_LOSS_PCT")}%\n` +
            `• Trailing Stop: ${configService.getNumber("TRAILING_STOP_PCT")}%\n` +
            `• Stale Timeout: ${configService.getNumber("STALE_POSITION_MINUTES")} min`
          );
          return;
        }

        if (query.data === "risk") {
          await ctx.answerCbQuery();
          await ctx.reply(
            "⚠️ Risk Parameters\n" +
            `• Max Trade Size: ${configService.getNumber("MAX_TRADE_SIZE_SOL")} SOL\n` +
            `• Slippage: ${configService.getNumber("SLIPPAGE_BPS")} bps\n` +
            `• Jito Tip: ${configService.getNumber("JITO_TIP_LAMPORTS")} lamports\n` +
            `• Max Positions: ${configService.getNumber("MAX_CONCURRENT_POSITIONS")}`
          );
          return;
        }

        if (query.data === "ingestion") {
          await ctx.answerCbQuery();
          await ctx.reply(
            "🔍 Ingestion Parameters\n" +
            `• Trending Tokens: ${configService.getNumber("MAX_TRENDING_TOKENS")}\n` +
            `• Top Traders: ${configService.getNumber("MAX_TOP_TRADERS")}\n` +
            `• Poll Interval: ${configService.getNumber("INGESTION_INTERVAL_MS")}ms\n` +
            `• Min Trader PnL: $${configService.getNumber("MIN_TRADER_PNL_USD")}`
          );
          return;
        }

        if (query.data === "forensics") {
          await ctx.answerCbQuery();
          await ctx.reply(
            "🧬 Forensics Parameters\n" +
            `• Max Rug Score: ${configService.getNumber("RUGCHECK_MAX_SCORE")}\n` +
            `• Min Liquidity: $${configService.getNumber("MIN_LIQUIDITY_USD")}\n` +
            `• Max Top10 Concentration: ${configService.getNumber("MAX_TOP10_CONCENTRATION_PCT")}%\n` +
            `• Mirror Interval: ${configService.getNumber("WALLET_MIRROR_INTERVAL_MS")}ms`
          );
          return;
        }

        if (query.data === "toggle_log_stream") {
          this.logStreamEnabled = !this.logStreamEnabled;
          logger.info("TELEGRAM", "TelegramAdminBot", "Log streaming toggled", { enabled: this.logStreamEnabled });
          await ctx.answerCbQuery(`Log stream: ${this.logStreamEnabled ? "ON" : "OFF"}`);
          return;
        }

        if (query.data === "clear_db") {
          const db = watchlistService.getDb();
          const wt = db.prepare("DELETE FROM watched_tokens").run();
          const wtr = db.prepare("DELETE FROM watched_traders").run();
          const pos = db.prepare("DELETE FROM positions").run();
          const tr = db.prepare("DELETE FROM trades").run();
          const tj = db.prepare("DELETE FROM trade_journal").run();
          resetSessionPnl();
          logger.info("TELEGRAM", "TelegramAdminBot", "Database cleared via button");
          await ctx.answerCbQuery(`Database cleared: ${wt.changes} watched_tokens, ${wtr.changes} watched_traders, ${pos.changes} positions, ${tr.changes} trades, ${tj.changes} journal entries. Session PnL reset.`);
          return;
        }

        if (query.data === "toggle_war_room") {
          this.warRoomEnabled = !this.warRoomEnabled;
          logger.info("TELEGRAM", "TelegramAdminBot", "War room streaming toggled", { enabled: this.warRoomEnabled });
          await ctx.answerCbQuery(`War room: ${this.warRoomEnabled ? "ON" : "OFF"}`);
          return;
        }
      } catch (e) {
        logger.error("TELEGRAM", "TelegramAdminBot", "Callback error", { error: e.message });
        try {
          await ctx.answerCbQuery(`Error: ${e.message}`);
        } catch (_) {
          // ignore
        }
      }
    });
  }

  private async showSettingsList(ctx: any) {
    try {
      const allConfig = configService.getAll();
      let message = "⚙️ AVAILABLE SETTINGS\n\n";
      message += "Use /set <KEY> <VALUE> to update.\n\n";

      const categoryIcons: Record<string, string> = {
        INGESTION: "🔍",
        EVALUATOR: "🧠",
        FORENSICS: "🧬",
        RISK: "⚠️",
        EXITS: "💰",
        LOGGING: "📝"
      };

      for (const [category, settings] of allConfig) {
        const icon = categoryIcons[category] || "⚙️";
        message += `${icon} ${category}\n`;
        message += "─".repeat(20) + "\n";
        
        for (const setting of settings) {
          message += `• ${setting.key} = ${setting.value}\n`;
        }
        message += "\n";
      }

      // Split if too long for Telegram (4096 char limit)
      if (message.length > 4000) {
        const parts = this.splitMessage(message, 4000);
        for (let i = 0; i < parts.length; i++) {
          await ctx.reply(parts[i]);
        }
      } else {
        await ctx.reply(message);
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show settings list", { error: e.message });
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  private splitMessage(message: string, maxSize: number): string[] {
    const parts: string[] = [];
    let remaining = message;
    
    while (remaining.length > 0) {
      if (remaining.length <= maxSize) {
        parts.push(remaining);
        break;
      }
      
      // Find a line break near the end
      let splitPoint = remaining.lastIndexOf("\n", maxSize);
      if (splitPoint === -1) {
        splitPoint = maxSize;
      }
      
      parts.push(remaining.substring(0, splitPoint));
      remaining = remaining.substring(splitPoint + 1);
    }
    
    return parts;
  }

  private async showMainMenu(ctx) {
    const dryRun = configService.getBoolean("DRY_RUN_MODE");
    const positions = watchlistService.getActivePositionsCount();
    const menuText = `⚙️ SWARM ADMIN MENU

🔴 Mode: ${dryRun ? "DRY_RUN" : "LIVE"}
📍 Positions: ${positions}`;

    const logStreamBtn = this.logStreamEnabled ? "📡 Log Stream (ON)" : "📡 Log Stream (OFF)";
    const warRoomBtn = this.warRoomEnabled ? "🧠 War Room (ON)" : "🧠 War Room (OFF)";

    const buttons: any[][] = [
      [
        Markup.button.callback(dryRun ? "🔴 DRY_RUN (ON)" : "🟢 LIVE (OFF)", "toggle_dry_run"),
        Markup.button.callback("📊 Status", "show_status")
      ],
      [
        Markup.button.callback(logStreamBtn, "toggle_log_stream"),
        Markup.button.callback(warRoomBtn, "toggle_war_room")
      ],
      [
        Markup.button.callback("💰 Exits", "exits"),
        Markup.button.callback("⚠️ Risk", "risk")
      ],
      [
        Markup.button.callback("🔍 Ingestion", "ingestion"),
        Markup.button.callback("🧬 Forensics", "forensics")
      ],
      [
        Markup.button.callback("📝 Logging", "log_menu"),
        Markup.button.callback("🗑️ Clear DB", "clear_db")
      ]
    ];

    const keyboard = Markup.inlineKeyboard(buttons);
    await ctx.reply(menuText, keyboard);
  }

  private async showLogMenu(ctx) {
    const globalLevel = logger.getGlobalLogLevel();

    let text = "📝 LOGGING CONFIGURATION\n\n";
    text += "Global Level:\n";
    text += `Current: ${globalLevel}\n\n`;

    text += "Level Guide:\n";
    text += "🔵 DEBUG - Verbose: every trade step, API calls\n";
    text += "🟢 INFO - Normal operations (default)\n";
    text += "🟡 WARN - Warnings only (missed trades, issues)\n";
    text += "🔴 ERROR - Errors only\n";
    text += "⚫ SILENT - No output\n\n";

    const levelButtons: any[][] = [];
    const row: any[] = [];
    for (const level of LOG_LEVELS) {
      const icon = level === globalLevel ? "✓ " : "";
      row.push(Markup.button.callback(`${icon}${level}`, `log_global_${level}`));
      if (row.length === 3) {
        levelButtons.push([...row]);
        row.length = 0;
      }
    }
    if (row.length > 0) {
      levelButtons.push([...row]);
    }

    text += "Category Overrides:\n";
    text += "Tap a category to set its level:\n\n";

    const categoryButtons: any[][] = [];
    let catRow: any[] = [];
    for (const cat of LOG_CATEGORIES) {
      catRow.push(Markup.button.callback(cat, `log_cat_${cat}:INFO`));
      if (catRow.length === 3) {
        categoryButtons.push([...catRow]);
        catRow = [];
      }
    }
    if (catRow.length > 0) {
      categoryButtons.push([...catRow]);
    }

    const allButtons = [...levelButtons, ...categoryButtons];
    const keyboard = Markup.inlineKeyboard(allButtons);
    await ctx.reply(text, keyboard);
  }

  private async showDashboard(ctx: any) {
    try {
      await ctx.replyWithChatAction("typing");
      const metrics = await watchlistService.getDashboardMetrics();
      const formattedHtml = TelegramDashboardFormatter.formatDashboard(metrics);
      await ctx.reply(formattedHtml, { parse_mode: "HTML" });
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to generate dashboard", { error: e.message });
      await ctx.reply(`⚠️ Dashboard generation error: ${e.message}`);
    }
  }

  private async showPositions(ctx: any) {
    try {
      const metrics = await watchlistService.getDashboardMetrics();

      if (metrics.positions.length === 0) {
        return ctx.reply("ℹ️ No active open positions.");
      }

      let msg = `<b>🎯 OPEN POSITIONS (${metrics.positions.length})</b>\n\n`;
      metrics.positions.forEach((pos, i) => {
        const posPnlEmoji = pos.unrealized_pnl_pct >= 0 ? "📈" : "📉";
        const shortenedMint = `${pos.mint_address.slice(0, 4)}...${pos.mint_address.slice(-4)}`;

        msg += `<b>${i + 1}. $${pos.symbol}</b> (<code>${shortenedMint}</code>)\n`;
        msg += `  • <b>Size:</b> <code>${pos.amount_sol} SOL</code>\n`;
        msg += `  • <b>Entry $ :</b> <code>$${pos.entry_price_usd.toFixed(6)}</code>\n`;
        msg += `  • <b>Current $:</b> <code>$${pos.current_price_usd.toFixed(6)}</code>\n`;
        msg += `  • <b>Peak High $:</b> <code>$${pos.peak_price_usd.toFixed(6)}</code>\n`;
        msg += `  • <b>PnL:</b> ${posPnlEmoji} <b>${pos.unrealized_pnl_pct >= 0 ? '+' : ''}${pos.unrealized_pnl_pct.toFixed(2)}%</b> (<code>${pos.unrealized_pnl_sol >= 0 ? '+' : ''}${pos.unrealized_pnl_sol.toFixed(4)} SOL</code>)\n`;
        msg += `  • <b>Trailing SL:</b> <code>$${pos.trailing_stop_level_usd.toFixed(6)}</code>\n`;
        msg += `  • <b>Tier:</b> <code>${pos.trailing_tier}</code>\n\n`;
      });

      if (msg.length > 4000) {
        const parts = this.splitMessage(msg, 4000);
        for (let i = 0; i < parts.length; i++) {
          await ctx.reply(parts[i], { parse_mode: "HTML" });
        }
      } else {
        await ctx.reply(msg, { parse_mode: "HTML" });
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to get positions", { error: e.message });
      await ctx.reply(`Error fetching positions: ${e.message}`);
    }
  }

  private async showTradeJournal(ctx: any) {
    try {
      // Phase 2C: support optional filter arg, e.g. /trades BONK or /trades FAILED
      let trades = watchlistService.listRecentTrades(10);
      let filterLabel = "last 10";

      if (ctx.args && ctx.args.length > 0) {
        const arg = ctx.args[0].toUpperCase();
        // Treat arg as mint or status
        const statuses = ["PAPER", "FILLED", "FAILED", "QUOTED"];
        if (statuses.includes(arg)) {
          trades = watchlistService.listTrades({ status: arg, limit: 10 });
          filterLabel = `status=${arg}`;
        } else {
          trades = watchlistService.listTrades({ mint: arg, limit: 10 });
          filterLabel = `mint=${arg}`;
        }
      }

      if (trades.length === 0) {
        return ctx.reply(`no trades (${filterLabel})`);
      }

      let text = `📊 TRADE JOURNAL (${filterLabel})\n`;
      text += "mode | side | sym | sol_in/sol_out | status | age\n";
      text += "─".repeat(60) + "\n";

      for (const t of trades) {
        const mode = t.mode === "DRY_RUN" ? "DRY" : "LIVE";
        const symbol = t.symbol || t.mint.slice(0, 6) + "...";
        const solIn = t.sol_in != null ? t.sol_in.toFixed(2) : "—";
        const solOut = t.sol_out != null ? t.sol_out.toFixed(2) : "—";
        const age = this.relativeAge(t.created_at);
        const reasonPart = t.reason
          ? ` ${t.reason.slice(0, 72)}`
          : "";
        text += `${mode} ${t.side} ${symbol} ${solIn}/${solOut} ${t.status} ${age}${reasonPart}\n`;
      }

      await ctx.reply(text);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show trade journal", { error: e.message });
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  private async showGamma(ctx: any) {
    try {
      const arg = ctx.args?.[0];

      if (arg) {
        // Specific token: resolve mint from symbol or exact mint
        const mint = await this.resolveMint(arg);
        if (!mint) {
          return ctx.reply(`no gamma snapshot for ${arg}`);
        }
        const snap = watchlistService.getGammaSnapshot(mint);
        if (!snap) {
          return ctx.reply(`no gamma snapshot for ${arg}`);
        }
        const symbol = snap.symbol || arg;
        let pa = null;
        try {
          pa = snap.pa;
        } catch (e) {
          // bad JSON, treat as null
        }
        const hvStr = snap.hv != null ? ` ${snap.hv.toFixed(2)}` : "";
        const regimeStr = snap.regime || "";
        const age = this.relativeAge(snap.at);
        const reasons = (snap.reasons || "").slice(0, 240);

        let msg = `GAMMA $${symbol}\n`;
        msg += `dec ${snap.decision} conv=${snap.conviction?.toFixed(2) ?? "n/a"}\n`;
        if (pa) {
          const srcPrefix = pa.source === "dex" ? "src=dex " : "";
          const vwapStr = pa.vwapRatio != null ? ` ${pa.vwapRatio.toFixed(2)}` : "";
          const bsStr = pa.buySellRatio5m != null ? ` ${pa.buySellRatio5m.toFixed(2)}` : "";
          const peakStr = pa.distanceFromPeakPct != null ? ` ${pa.distanceFromPeakPct.toFixed(1)}%` : "";
          const emaStr = pa.emaTrend || "";
          const overStr = typeof pa.isOverextended === "boolean" ? ` ${pa.isOverextended ? "yes" : "no"}` : "";
          msg += `${srcPrefix}vwap${vwapStr}  bs5m${bsStr}  peak${peakStr}  ema ${emaStr}  overext${overStr}\n`;
          if (pa.features) {
            msg += `${this.formatCandleFeatures(pa.features)}\n`;
          }
        } else {
          msg += "PA unavailable\n";
        }
        msg += `hv${hvStr}  regime ${regimeStr}\n`;
        msg += `reasons: ${reasons}\n`;
        msg += `age ${age}`;
        return ctx.reply(msg);
      }

      // No arg: last 8 snapshots
      const snaps = watchlistService.listGammaSnapshots(8);
      if (snaps.length === 0) {
        return ctx.reply("no gamma snapshots");
      }

      let msg = "";
      for (let i = 0; i < snaps.length; i++) {
        const s = snaps[i];
        const symbol = s.symbol || s.mint_address.slice(0, 6) + "...";
        let pa = null;
        try {
          pa = s.pa_json ? JSON.parse(s.pa_json) : null;
        } catch (e) {
          // bad JSON, treat as null
        }
        const age = this.relativeAge(s.at);
        const convStr = s.conviction != null ? s.conviction.toFixed(2) : "n/a";

        // Header line: decision symbol age
        if (i > 0) msg += "\n";
        msg += `${s.decision}  ${symbol}  ${age}\n`;

        // Second line: conv, src, tf, bars (omit tf/bars when pa is null)
        const parts: string[] = [`conv ${convStr}`];
        if (pa) {
          const src = pa.source;
          const tf = pa.interval;
          if (src) parts.push(`src=${src}`);
          parts.push(tf ? `tf=${tf}` : "tf=na");
          parts.push(pa.features ? `bars=${pa.features.barCount}` : "bars=na");
        }
        msg += `  ${parts.join("  ")}\n`;

        // Third line: price action facts
        const facts: string[] = [];
        if (pa?.distanceFromPeakPct != null) {
          const label = src === "dex" ? "5m" : "peak";
          facts.push(`${label} ${pa.distanceFromPeakPct.toFixed(0)}%`);
        }
        if (pa?.buySellRatio5m != null) {
          facts.push(`bs ${pa.buySellRatio5m.toFixed(1)}`);
        }
        if (src !== "dex" && pa?.emaTrend && pa.emaTrend !== "NEUTRAL") {
          facts.push(`ema ${pa.emaTrend}`);
        }
        if (s.hv != null) {
          facts.push(`hv ${s.hv.toFixed(2)}`);
        }
        if (s.regime) {
          facts.push(s.regime);
        }
        if (facts.length > 0) {
          msg += `  ${facts.join("  ")}\n`;
        }
      }
      if (msg.length > 3500) {
        msg = msg.substring(0, 3500) + "\n... (truncated)";
      }
      return ctx.reply(msg);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show gamma", { error: e.message });
      return ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  private resolveMint(query: string): string | null {
    // Try exact mint first
    try {
      new PublicKey(query);
      return query;
    } catch (_) {}

    // Try case-insensitive symbol match on watched_tokens
    const db = watchlistService.getDb();
    try {
      const row = db
        .prepare("SELECT mint_address FROM watched_tokens WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
        .get(query);
      if (row) return row.mint_address;
    } catch (_) {}

    // Try case-insensitive symbol match on positions
    try {
      const row = db
        .prepare("SELECT mint_address FROM positions WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
        .get(query);
      if (row) return row.mint_address;
    } catch (_) {}

    return null;
  }

  private async showPnl(ctx: any) {
    try {
      const { getSessionPnl } = await import("../execution/risk.ts");
      const { isDryRun } = await import("../utils/env.ts");
      const pnl = getSessionPnl();
      const mode = isDryRun() ? "DRY_RUN" : "LIVE";
      const positions = watchlistService.getActivePositionsCount();

      const pnlEmoji = pnl >= 0 ? "📈" : "📉";
      let text = `${pnlEmoji} SESSION PnL\n`;
      text += `Session PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL\n`;
      text += `Open positions: ${positions}\n`;
      text += `Mode: ${mode}`;

      await ctx.reply(text);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show PnL", { error: e.message });
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  private async showBook(ctx: any) {
    try {
      const arg = ctx.args?.[0];
      let hoursBack: number | null = null;
      if (arg === "24h" || arg === "24") {
        hoursBack = 24;
      }
      const { trips, lines } = aggregateBook(hoursBack);
      if (trips.length === 0) {
        return ctx.reply("BOOK empty");
      }
      let msg = lines.join("\n");
      if (msg.length > 3500) {
        msg = msg.substring(0, 3500) + "\n... (truncated)";
      }
      await ctx.reply(msg);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show book", { error: e.message });
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  private relativeAge(timestampMs: number): string {
    const now = Date.now();
    const diff = now - timestampMs;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  }

  // Phase 11B: format candle features for gamma detail view
  private formatCandleFeatures(f: any): string {
    if (!f) return "features: none";
    const trimStr = f.trimmed ? "trim=yes" : "trim=no";
    const okStr = f.sufficient ? "ok" : "PA_INSUFFICIENT";
    const sma5 = f.sma5 != null ? `sma5=${f.sma5.toFixed(2)}` : "sma5=n/a";
    const sma20 = f.sma20 != null ? `sma20=${f.sma20.toFixed(2)}` : "sma20=n/a";
    const rsi = f.rsi14 != null ? `rsi=${f.rsi14.toFixed(0)}` : "rsi=n/a";
    const dV = f.volumeChange != null ? `dV=${f.volumeChange.toFixed(0)}%` : "dV=n/a";
    return `bars ${f.barCount} ${trimStr} ${okStr} ${sma5} ${sma20} ${rsi} ${dV}`;
  }

  async start() {
    if (this.started) return;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.info("TELEGRAM", "TelegramAdminBot", "TELEGRAM skip: NO_TOKEN");
      return;
    }

    this.bot = new Telegraf(token);
    this.registerCommands();
    this.registerCallbacks();

    // Phase 9C: log all inbound text commands
    this.bot.use(async (ctx, next) => {
      if (ctx.message?.text) {
        logger.info("TELEGRAM", "TelegramAdminBot", "tg in", {
          chat: ctx.chat?.id,
          from: ctx.from?.id,
          text: ctx.message.text
        });
      }
      await next();
    });

    this.bot.catch((err: any, ctx: any) => {
      logger.error("TELEGRAM", "TelegramAdminBot", "Unhandled Telegram bot error", { error: err.message });
    });

    try {
      // Phase 9A: validate token fast
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      const me = await this.bot.telegram.getMe(); // fails fast on 401
      // Phase 9C: log bot identity
      logger.info("TELEGRAM", "TelegramAdminBot", "tg identity", {
        username: me.username,
        id: me.id
      });

      // Phase 9A2: do not await launch(); it blocks forever (poll loop)
      void this.bot.launch({ dropPendingUpdates: true }).catch((e: any) => {
        logger.error("TELEGRAM", "TelegramAdminBot", "Poll loop error", { error: e?.message, status: e?.status });
        if (e?.message?.includes("409") || e?.message?.includes("Conflict")) {
          logger.error("TELEGRAM", "TelegramAdminBot", "another process is polling this bot token; kill it");
        }
        this.started = false;
      });

      this.started = true;
      logger.info("TELEGRAM", "TelegramAdminBot", "Admin bot started and polling");
    } catch (e: any) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to start admin bot", { error: e.message, status: e?.status });
      throw e;
    }
  }

  async stop() {
    if (!this.started || !this.bot) return;

    try {
      await this.bot.stop();
      logger.info("TELEGRAM", "TelegramAdminBot", "Admin bot stopped");
      this.started = false;
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to stop admin bot", { error: e.message });
    }
  }

  async notifyAdmin(text: string) {
    if (!this.bot) {
      logger.debug("TELEGRAM", "TelegramAdminBot", "notifyAdmin: bot not started");
      return;
    }
    if (!this.adminChatId) {
      logger.debug("TELEGRAM", "TelegramAdminBot", "No admin chat ID configured");
      return;
    }

    try {
      logger.info("TELEGRAM", "TelegramAdminBot", "Sending notification", { text: text.slice(0, 100) });
      await this.bot.telegram.sendMessage(this.adminChatId, text);
    } catch (e: any) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to send notification", {
        error: e.description || e.message,
        status: e.status
      });
    }
  }

  /**
   * Phase 2C: single trade fill notify, called from TradeExecutionService.
   */
  async notifyTrade(trade: {
    side: string;
    symbol: string;
    status: string;
    mode?: string;
    solIn?: number;
    solOut?: number;
    mint?: string;
    txSig?: string;
    reason?: string;
  }) {
    const modeLabel = trade.mode === "DRY_RUN" ? "PAPER" : "LIVE";
    const symbol = trade.symbol || trade.mint?.slice(0, 6) + "...";
    let msg = `📊 ${modeLabel} ${trade.side} ${symbol}`;
    if (trade.solIn != null) msg += ` (in ${trade.solIn.toFixed(2)} SOL)`;
    if (trade.solOut != null) msg += ` (out ${trade.solOut.toFixed(2)} SOL)`;
    if (trade.txSig) msg += ` \`${trade.txSig.slice(0, 12)}...\``;
    await this.notifyAdmin(msg);
  }

  async sendToChat(text: string): Promise<void> {
    if (!this.bot) {
      logger.debug("TELEGRAM", "TelegramAdminBot", "sendToChat: bot not started");
      return;
    }
    // Phase 9A: telemetry chat ID takes priority, fallback to admin chat ID
    const chatId = process.env.TELEGRAM_TELEMETRY_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!chatId) {
      logger.info("TELEGRAM", "TelegramAdminBot", "NO_CHAT_ID (no TELEGRAM_TELEMETRY_CHAT_ID and no TELEGRAM_ADMIN_CHAT_ID)");
      return;
    }

    const source = process.env.TELEGRAM_TELEMETRY_CHAT_ID ? "TELEGRAM_TELEMETRY_CHAT_ID" : "TELEGRAM_ADMIN_CHAT_ID";

    try {
      // DEBUG only to avoid infinite loop when streaming is enabled
      logger.debug("TELEGRAM", "TelegramAdminBot", "Sending message to chat", { chatId, source });
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (e: any) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to send message", {
        error: e.description || e.message,
        status: e.status,
        chatId: chatId
      });
    }
  }

  /**
   * Stream a log message to the Telegram chat.
   * Pauses streaming while admin is sending commands (debounce-style).
   */
  async streamLog(level: string, component: string, message: string): Promise<void> {
    if (!this.logStreamEnabled || this.logStreamPaused) {
      return;
    }

    const icons: Record<string, string> = {
      DEBUG: "🔵",
      INFO: "ℹ️",
      WARN: "⚠️",
      ERROR: "❌"
    };
    const icon = icons[level] || "📝";

    const text = `${icon} [${level}] ${component}: ${message}`;
    await this.sendToChat(text);
  }

  /**
   * Pause/resume log streaming (e.g., while admin is interacting)
   */
  setLogStreamPaused(paused: boolean) {
    this.logStreamPaused = paused;
  }

  /**
   * Stream an inter-agent war room / committee message to Telegram.
   */
  async streamWarRoomMessage(agent: string, event: string, details?: any): Promise<void> {
    if (!this.warRoomEnabled || this.warRoomPaused) {
      return;
    }

    let text = `🧠 [COMMITTEE - ${agent}]
Event: ${event}`;

    if (details) {
      try {
        const detailStr = typeof details === "string" ? details : JSON.stringify(details, null, 2);
        // Truncate very long details
        const truncated = detailStr.length > 4000 ? detailStr.slice(0, 4000) + "..." : detailStr;
        text += `\nDetails: \`${truncated}\``;
      } catch (e) {
        text += `\nDetails: [unserializable]`;
      }
    }

    await this.sendToChat(text);
  }

  /**
   * Pause/resume war room streaming
   */
  setWarRoomPaused(paused: boolean) {
    this.warRoomPaused = paused;
  }

  getLogStreamEnabled(): boolean {
    return this.logStreamEnabled;
  }

  getWarRoomEnabled(): boolean {
    return this.warRoomEnabled;
  }
}

export const telegramAdminBot = new TelegramAdminBot();
export default telegramAdminBot;