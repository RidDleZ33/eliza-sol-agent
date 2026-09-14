import { Telegraf, Markup } from "telegraf";
import { configService, ConfigKey } from "./ConfigService.ts";
import { logger, LogLevel } from "./LoggerService.ts";
import { watchlistService } from "./WatchlistService.ts";

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

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

    if (!token) {
      logger.warn("TELEGRAM", "TelegramAdminBot", "TELEGRAM_BOT_TOKEN not set, admin bot disabled");
    }

    this.bot = new Telegraf(token || "");
    this.registerCommands();
    this.registerCallbacks();
  }

  private isAdmin(userId: number): boolean {
    return String(userId) === this.adminChatId;
  }

  private registerCommands() {
    this.bot.command(["settings", "config"], async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      await this.showMainMenu(ctx);
    });

    this.bot.command("set", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      const args = ctx.args;
      if (!args || args.length < 2) {
        await ctx.reply("Usage: /set <KEY> <VALUE>\nExample: /set TAKE_PROFIT_PCT 75");
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

    this.bot.command("status", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      await this.showStatus(ctx);
    });

    this.bot.command("logs", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      await this.showLogMenu(ctx);
    });

    this.bot.command("loglevel", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
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
        "/status - Current swarm status\n" +
        "/logs - Logging configuration\n" +
        "\n" +
        "⚙️ Config:\n" +
        "/set KEY VALUE - Update a setting\n" +
        "/toggle KEY - Toggle boolean value\n" +
        "/loglevel LEVEL - Set global log level\n" +
        "/logcategory CAT LEVEL - Set category log level"
      );
    });
  }

  private registerCallbacks() {
    this.bot.on("callback_query", async (ctx) => {
      const query = ctx.callbackQuery;
      if (!query.data) return;

      try {
        logger.debug("TELEGRAM", "TelegramAdminBot", "Callback received", { data: query.data });

        if (query.data === "toggle_dry_run") {
          await configService.toggle("DRY_RUN_MODE");
          const value = configService.getBoolean("DRY_RUN_MODE");
          logger.info("TELEGRAM", "TelegramAdminBot", "DRY_RUN_MODE toggled", { value });
          await query.answer(`DRY_RUN: ${value ? "ON" : "OFF"}`);
          return;
        }

        if (query.data === "show_status") {
          await query.answer();
          await this.showStatus(ctx);
          return;
        }

        if (query.data === "log_menu") {
          await query.answer();
          await this.showLogMenu(ctx);
          return;
        }

        if (query.data.startsWith("log_global_")) {
          const level = query.data.replace("log_global_", "").toUpperCase() as LogLevel;
          logger.setGlobalLogLevel(level);
          logger.info("TELEGRAM", "TelegramAdminBot", "Global log level set via button", { level });
          await query.answer(`Global log level: ${level}`);
          await this.showLogMenu(ctx);
          return;
        }

        if (query.data.startsWith("log_cat_")) {
          const parts = query.data.replace("log_cat_", "").split(":");
          const category = parts[0].toUpperCase();
          const level = parts[1].toUpperCase() as LogLevel;
          logger.setCategoryLogLevel(category as any, level);
          logger.info("TELEGRAM", "TelegramAdminBot", "Category log level set via button", { category, level });
          await query.answer(`${category}: ${level}`);
          return;
        }

        if (query.data === "exits") {
          await query.answer();
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
          await query.answer();
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
          await query.answer();
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
          await query.answer();
          await ctx.reply(
            "🧬 Forensics Parameters\n" +
            `• Max Rug Score: ${configService.getNumber("RUGCHECK_MAX_SCORE")}\n` +
            `• Min Liquidity: $${configService.getNumber("MIN_LIQUIDITY_USD")}\n` +
            `• Max Top10 Concentration: ${configService.getNumber("MAX_TOP10_CONCENTRATION_PCT")}%\n` +
            `• Mirror Interval: ${configService.getNumber("WALLET_MIRROR_INTERVAL_MS")}ms`
          );
          return;
        }
      } catch (e) {
        logger.error("TELEGRAM", "TelegramAdminBot", "Callback error", { error: e.message });
        try {
          await query.answer(`Error: ${e.message}`);
        } catch (_) {
          // ignore
        }
      }
    });
  }

  private async showMainMenu(ctx) {
    const dryRun = configService.getBoolean("DRY_RUN_MODE");
    const positions = watchlistService.getActivePositionsCount();
    const menuText = `⚙️ SWARM ADMIN MENU

🔴 Mode: ${dryRun ? "DRY_RUN" : "LIVE"}
📍 Positions: ${positions}`;

    const buttons: any[][] = [
      [
        Markup.button.callback(dryRun ? "🔴 DRY_RUN (ON)" : "🟢 LIVE (OFF)", "toggle_dry_run"),
        Markup.button.callback("📊 Status", "show_status")
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
        Markup.button.callback("📝 Logging", "log_menu")
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
        levelButtons.push(row);
        row.length = 0;
      }
    }
    if (row.length > 0) {
      levelButtons.push(row);
    }

    text += "Category Overrides:\n";
    text += "Tap a category to set its level:\n\n";

    const categoryButtons: any[][] = [];
    let catRow: any[] = [];
    for (const cat of LOG_CATEGORIES) {
      catRow.push(Markup.button.callback(cat, `log_cat_${cat}:INFO`));
      if (catRow.length === 3) {
        categoryButtons.push(catRow);
        catRow = [];
      }
    }
    if (catRow.length > 0) {
      categoryButtons.push(catRow);
    }

    const allButtons = [...levelButtons, categoryButtons];
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
      const openPositions = await watchlistService.getOpenPositions();
      if (openPositions.length > 0) {
        statusText += "\nOpen Positions:\n";
        for (const pos of openPositions) {
          statusText += `• ${pos.symbol || pos.mint_address} (entered ${pos.entered_at})\n`;
        }
      }
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to get open positions", { error: e.message });
    }

    await ctx.reply(statusText);
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
      logger.info("TELEGRAM", "TelegramAdminBot", "Sending message to chat", { chatId });
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (e) {
      logger.error("TELEGRAM", "TelegramAdminBot", "Failed to send message", { error: e.message });
    }
  }
}

export const telegramAdminBot = new TelegramAdminBot();
export default telegramAdminBot;