import { Telegraf, Markup } from "telegraf";
import { configService, ConfigKey } from "./ConfigService.ts";
import { logger, LogLevel } from "./LoggerService.ts";
import { watchlistService } from "./WatchlistService.ts";

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
  private bot: Telegraf<any>;
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
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

    if (!token) {
      logger.warn("TELEGRAM", "TelegramAdminBot", "TELEGRAM_BOT_TOKEN not set, admin bot disabled");
    }

    this.bot = new Telegraf(token || "");
    this.registerCommands();
    this.registerCallbacks();

    this.bot.catch((err: any, ctx: any) => {
      logger.error("TELEGRAM", "TelegramAdminBot", "Unhandled Telegram bot error", { error: err.message });
    });
  }

  private isAdmin(userId: number): boolean {
    return String(userId) === this.adminChatId;
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
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showTradeJournal(ctx);
    });

    this.bot.command("status", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showStatus(ctx);
    });

    this.bot.command("logs", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      await this.showLogMenu(ctx);
    });

    this.bot.command("logstream", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      this.pauseLogStream();
      this.pauseWarRoom();
      
      if (!ctx.args || ctx.args.length < 1 || ctx.args[0] !== "yes") {
        await ctx.reply("⚠️ This will clear all watched tokens, traders, and positions.\nType /cleardb yes to confirm.");
        return;
      }
      
      try {
        const db = watchlistService.getDb();
        db.exec("DELETE FROM watched_tokens");
        db.exec("DELETE FROM watched_traders");
        db.exec("DELETE FROM positions");
        
        logger.info("TELEGRAM", "TelegramAdminBot", "Database cleared via admin command");
        await ctx.reply("✅ Database cleared. Fresh start.");
      } catch (e) {
        logger.error("TELEGRAM", "TelegramAdminBot", "Failed to clear database", { error: e.message });
        await ctx.reply(`❌ Failed: ${e.message}`);
      }
    });

    this.bot.command("warroom", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
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
      if (!this.isAdmin(ctx.from!.id)) {
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

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        "🤖 Swarm Admin Commands\n\n" +
        "📋 Management:\n" +
        "/settings - Main configuration menu\n" +
        "/settings list - View all available settings\n" +
        "/status - Current swarm status\n" +
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
          await this.showStatus(ctx);
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
          db.exec("DELETE FROM watched_tokens");
          db.exec("DELETE FROM watched_traders");
          db.exec("DELETE FROM positions");
          logger.info("TELEGRAM", "TelegramAdminBot", "Database cleared via button");
          await ctx.answerCbQuery("Database cleared");
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

  private async showStatus(ctx) {
    const positions = watchlistService.getActivePositionsCount();
    const dryRun = configService.getBoolean("DRY_RUN_MODE");
    const tradeSize = configService.getNumber("MAX_TRADE_SIZE_SOL");

    let statusText = "🤖 SWARM STATUS\n\n";
    statusText += `📍 Active Positions: ${positions}\n`;
    statusText += `💰 Trade Size: ${tradeSize} SOL\n`;
    statusText += `🔴 Mode: ${dryRun ? "DRY_RUN" : "LIVE"}\n`;
    statusText += `📈 Take Profit: ${configService.getNumber("TAKE_PROFIT_PCT")}%\n`;
    statusText += `📉 Stop Loss: ${configService.getNumber("STOP_LOSS_PCT")}%\n`;

    try {
      const openPositions = await watchlistService.getOpenPositions(isDryRun);
      if (openPositions.length > 0) {
        statusText += `\nOpen ${currentMode} Positions:\n`;
        for (const pos of openPositions) {
          statusText += `• ${pos.symbol || pos.mint_address}\n`;
        }
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to get open positions", { error: e.message });
    }

    // Show recent trade journal summary
    try {
      const tradeState = await watchlistService.getCompleteTradeState();
      const journal = tradeState.journalAuditTrail;
      
      if (journal.length > 0) {
        statusText += "\n📝 Recent Trade Activity:\n";
        const recentEntries = journal.slice(0, 5);
        for (const entry of recentEntries) {
          let icon = "📝";
          if (entry.event_type === "BUY_INTENT") icon = "👁️";
          else if (entry.event_type === "BUY_EXECUTED") icon = "✅";
          else if (entry.event_type === "BUY_FAILED") icon = "❌";
          else if (entry.event_type === "SELL_EXECUTED") icon = "💸";
          else if (entry.event_type === "STOP_LOSS_UPDATED") icon = "🔄";
          else if (entry.event_type === "PRUNED") icon = "🗑️";
          
          const symbol = entry.symbol || entry.mint_address.slice(0, 8) + "...";
          statusText += `${icon} ${symbol}: ${entry.event_type}`;
          if (entry.price_usd) statusText += ` @ $${entry.price_usd.toFixed(4)}`;
          statusText += "\n";
        }
        if (journal.length > 5) {
          statusText += `... ${journal.length - 5} more entries (see /trades)`;
        }
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to get trade journal", { error: e.message });
    }

    await ctx.reply(statusText);
  }

  private async showTradeJournal(ctx: any) {
    try {
      const tradeState = await watchlistService.getCompleteTradeState();
      const journal = tradeState.journalAuditTrail;
      const openPositions = tradeState.openPositions;

      let text = "📊 TRADE JOURNAL & STATE\n\n";
      text += `📍 Open Positions: ${tradeState.activePositionsCount}\n`;
      text += `📋 Pending Candidates: ${tradeState.pendingCandidatesCount}\n`;
      text += `📝 Journal Entries: ${journal.length}\n\n`;

      if (journal.length === 0) {
        text += "No trade journal entries yet.";
        await ctx.reply(text);
        return;
      }

      // Group by token
      const grouped = new Map<string, any[]>();
      for (const entry of journal) {
        const key = entry.mint_address;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(entry);
      }

      // Show per token (most recent 10 tokens)
      let shown = 0;
      for (const [mint, entries] of grouped.entries()) {
        if (shown >= 10) break;
        shown++;
        const symbol = entries[0].symbol || mint.slice(0, 8) + "...";
        text += `🪙 ${escapeMd(symbol)} (${entries.length} events)\n`;

        for (const entry of entries.slice(0, 5)) {
          const eventType = entry.event_type;
          let icon = "📝";
          if (eventType === "BUY_INTENT") icon = "👁️";
          else if (eventType === "BUY_EXECUTED") icon = "✅";
          else if (eventType === "BUY_FAILED") icon = "❌";
          else if (eventType === "SELL_EXECUTED") icon = "💸";
          else if (eventType === "STOP_LOSS_UPDATED") icon = "🔄";
          else if (eventType === "PRUNED") icon = "🗑️";

          text += `  ${icon} ${escapeMd(eventType)}`;
          if (entry.price_usd) text += ` @ $${entry.price_usd.toFixed(4)}`;
          if (entry.tx_signature) text += ` \`${entry.tx_signature.slice(0, 12)}...\``;
          if (entry.reason) text += ` (${escapeMd(entry.reason.slice(0, 30))})`;
          text += "\n";
        }
      }

      if (text.length > 4000) {
        const parts = this.splitMessage(text, 4000);
        for (let i = 0; i < parts.length; i++) {
          await ctx.reply(parts[i]);
        }
      } else {
        await ctx.reply(text);
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to show trade journal", { error: e.message });
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  }

  async start() {
    if (this.started) return;

    try {
      this.bot.launch();
      logger.info("TELEGRAM", "TelegramAdminBot", "Admin bot started and polling");
      this.started = true;
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to start admin bot", { error: e.message });
    }
  }

  async stop() {
    if (!this.started) return;

    try {
      await this.bot.stop();
      logger.info("TELEGRAM", "TelegramAdminBot", "Admin bot stopped");
      this.started = false;
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to stop admin bot", { error: e.message });
    }
  }

  async notifyAdmin(text: string) {
    if (!this.adminChatId) {
      logger.debug("TELEGRAM", "TelegramAdminBot", "No admin chat ID configured");
      return;
    }

    try {
      logger.info("TELEGRAM", "TelegramAdminBot", "Sending notification", { text: text.slice(0, 100) });
      await this.bot.telegram.sendMessage(this.adminChatId, text);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to send notification", { error: e.message });
    }
  }

  async sendToChat(text: string): Promise<void> {
    const chatId = process.env.TELEGRAM_TELEMETRY_CHAT_ID;
    if (!chatId) {
      logger.debug("TELEGRAM", "TelegramAdminBot", "TELEGRAM_TELEMETRY_CHAT_ID not set");
      return;
    }

    try {
      // DEBUG only to avoid infinite loop when streaming is enabled
      logger.debug("TELEGRAM", "TelegramAdminBot", "Sending message to chat", { chatId });
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to send message", { error: e.message });
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