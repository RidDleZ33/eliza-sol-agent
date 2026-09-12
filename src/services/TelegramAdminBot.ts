import { Telegraf, Markup } from "telegraf";
import { configService, ConfigKey } from "./ConfigService.ts";
import { watchlistService } from "./WatchlistService.ts";

/**
 * Escape special Markdown characters for Telegram's parse_mode=Markdown.
 * Characters that need escaping: * _ [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdown(text: string): string {
  return String(text).replace(/([*_\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

interface AdminCommand {
  command: string;
  description: string;
}

export class TelegramAdminBot {
  private bot: Telegraf<any>;
  private adminChatId: string;
  private started = false;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

    if (!token) {
      console.warn("[TelegramAdminBot] TELEGRAM_BOT_TOKEN not set, admin bot disabled");
    }

    this.bot = new Telegraf(token || "");
    this.registerCommands();
  }

  private isAdmin(userId: number): boolean {
    return String(userId) === this.adminChatId;
  }

  private registerCommands() {
    // /settings or /config - show configuration menu
    this.bot.command(["settings", "config"], async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      await this.showConfigMenu(ctx);
    });

    // /set <KEY> <VALUE> - update a setting
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
        await ctx.reply(`✅ Updated ${key} = ${value}`);
      } catch (e) {
        await ctx.reply(`❌ Failed to update ${key}: ${e.message}`);
      }
    });

    // /toggle <KEY> - toggle boolean values
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
        await ctx.reply(`✅ Toggled ${key} = ${newValue}`);
      } catch (e) {
        await ctx.reply(`❌ Failed to toggle ${key}: ${e.message}`);
      }
    });

    // /status - show current status
    this.bot.command("status", async (ctx) => {
      if (!this.isAdmin(ctx.from!.id)) {
        await ctx.reply("⚠️ Admin access only.");
        return;
      }
      await this.showStatus(ctx);
    });

    // /help - show available commands
    this.bot.command("help", async (ctx) => {
      await ctx.reply("Available commands:\n" +
        "/settings or /config - View & manage configuration\n" +
        "/set <KEY> <VALUE> - Update a setting\n" +
        "/toggle <KEY> - Toggle boolean value\n" +
        "/status - View swarm status\n" +
        "/help - Show this message");
    });

    // Inline button callback handlers
    this.bot.on("callback_query", async (ctx) => {
      const query = ctx.callbackQuery;
      if (!query.data) return;

      try {
        switch (query.data) {
          case "toggle_dry_run": {
            await configService.toggle("DRY_RUN_MODE");
            const value = configService.getBoolean("DRY_RUN_MODE") ? "TRUE" : "FALSE";
            await query.answer(`DRY_RUN_MODE: ${value}`);
            break;
          }
          case "show_status": {
            await query.answer();
            await this.showStatus(ctx);
            break;
          }
          case "exits": {
            await query.answer();
            await ctx.reply("Exit rules:\n" +
              `• TAKE_PROFIT_PCT: ${configService.getNumber("TAKE_PROFIT_PCT")}%\n` +
              `• STOP_LOSS_PCT: ${configService.getNumber("STOP_LOSS_PCT")}%\n` +
              `• TRAILING_STOP_PCT: ${configService.getNumber("TRAILING_STOP_PCT")}%\n` +
              `• MAX_HOLD_TIME_MIN: ${configService.getNumber("MAX_HOLD_TIME_MIN")} min\n` +
              `• TIME_STOP_ENABLED: ${configService.getBoolean("TIME_STOP_ENABLED") ? "TRUE" : "FALSE"}`);
            break;
          }
          case "risk": {
            await query.answer();
            await ctx.reply("Risk parameters:\n" +
              `• MAX_TRADE_SIZE_SOL: ${configService.getNumber("MAX_TRADE_SIZE_SOL")}\n` +
              `• SLIPPAGE_BPS: ${configService.getNumber("SLIPPAGE_BPS")}\n` +
              `• JITO_TIP_LAMPORTS: ${configService.getNumber("JITO_TIP_LAMPORTS")}\n` +
              `• MAX_CONCURRENT_POSITIONS: ${configService.getNumber("MAX_CONCURRENT_POSITIONS")}`);
            break;
          }
          case "ingestion": {
            await query.answer();
            await ctx.reply("Ingestion parameters:\n" +
              `• MAX_TRENDING_TOKENS: ${configService.getNumber("MAX_TRENDING_TOKENS")}\n` +
              `• MAX_TOP_TRADERS: ${configService.getNumber("MAX_TOP_TRADERS")}\n` +
              `• INGESTION_INTERVAL_MS: ${configService.getNumber("INGESTION_INTERVAL_MS")}\n` +
              `• MIN_TRADER_PNL_USD: ${configService.getNumber("MIN_TRADER_PNL_USD")}`);
            break;
          }
          case "forensics": {
            await query.answer();
            await ctx.reply("Forensics parameters:\n" +
              `• RUGCHECK_MAX_SCORE: ${configService.getNumber("RUGCHECK_MAX_SCORE")}\n` +
              `• MIN_LIQUIDITY_USD: ${configService.getNumber("MIN_LIQUIDITY_USD")}\n` +
              `• MAX_TOP10_CONCENTRATION_PCT: ${configService.getNumber("MAX_TOP10_CONCENTRATION_PCT")}\n` +
              `• WALLET_MIRROR_INTERVAL_MS: ${configService.getNumber("WALLET_MIRROR_INTERVAL_MS")}`);
            break;
          }
        }
      } catch (e) {
        console.error("[TelegramAdminBot] Callback error:", e);
        try {
          await query.answer(`Error: ${e.message}`);
        } catch (_) {
          // ignore
        }
      }
    });
  }

  private async showConfigMenu(ctx) {
    const all = configService.getAll();

    // Build menu with inline keyboard
    const buttons: any[] = [];
    let menuText = "⚙️ *SWARM CONFIGURATION MENU*\n\n";

    // Group by category
    for (const [category, entries] of all) {
      menuText += `📊 *${category}*:\n`;
      for (const entry of entries) {
        let displayValue = entry.value;
        if (entry.key === "DRY_RUN_MODE") {
          displayValue = entry.value === "true" ? "TRUE" : "FALSE";
        }
        menuText += `• ${escapeMarkdown(entry.key)}: ${escapeMarkdown(String(displayValue))}\n`;
      }
      menuText += "\n";
    }

    // Add quick action buttons
    buttons.push([
      Markup.button.callback("🔴 Toggle DRY_RUN", "toggle_dry_run"),
      Markup.button.callback("📊 Status", "show_status")
    ]);
    buttons.push([
      Markup.button.callback("💰 Exits", "exits"),
      Markup.button.callback("⚠️ Risk", "risk")
    ]);
    buttons.push([
      Markup.button.callback("🔍 Ingestion", "ingestion"),
      Markup.button.callback("🧬 Forensics", "forensics")
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);
    await ctx.replyWithMarkdown(menuText, keyboard);
  }

  private async showStatus(ctx) {
    const positions = watchlistService.getActivePositionsCount();
    const dryRun = configService.getBoolean("DRY_RUN_MODE");
    const tradeSize = configService.getNumber("MAX_TRADE_SIZE_SOL");

    let statusText = "🤖 *SWARM STATUS*\n\n";
    statusText += `📍 Active Positions: ${escapeMarkdown(String(positions))}\n`;
    statusText += `💰 Trade Size: ${escapeMarkdown(String(tradeSize))} SOL\n`;
    statusText += `🔴 Mode: ${escapeMarkdown(dryRun ? "DRY_RUN" : "LIVE")}\n`;
    statusText += `📈 Take Profit: ${escapeMarkdown(String(configService.getNumber("TAKE_PROFIT_PCT")))}%\n`;
    statusText += `📉 Stop Loss: ${escapeMarkdown(String(configService.getNumber("STOP_LOSS_PCT")))}%\n`;

    // Get open positions details
    try {
      const openPositions = await watchlistService.getOpenPositions();
      if (openPositions.length > 0) {
        statusText += "\n*Open Positions:*\n";
        for (const pos of openPositions) {
          statusText += `• ${pos.symbol || pos.mint_address} (entered ${pos.entered_at})\n`;
        }
      }
    } catch (e) {
      // ignore
    }

    await ctx.replyWithMarkdown(statusText);
  }

  /**
   * Start polling for updates.
   */
  async start() {
    if (this.started) return;

    try {
      await this.bot.launch();
      console.log("[TelegramAdminBot] Admin bot started and polling");
      this.started = true;
    } catch (e) {
      console.error("[TelegramAdminBot] Failed to start:", e);
    }
  }

  /**
   * Stop polling.
   */
  async stop() {
    if (!this.started) return;

    try {
      await this.bot.stop();
      console.log("[TelegramAdminBot] Admin bot stopped");
      this.started = false;
    } catch (e) {
      console.error("[TelegramAdminBot] Failed to stop:", e);
    }
  }

  /**
   * Send a notification to admin.
   */
  async notifyAdmin(text: string) {
    if (!this.adminChatId) {
      console.log("[TelegramAdminBot] No admin chat ID configured, skipping notification");
      return;
    }

    try {
      await this.bot.telegram.sendMessage(this.adminChatId, text);
    } catch (e) {
      console.error("[TelegramAdminBot] Failed to send notification:", e);
    }
  }
}

export const telegramAdminBot = new TelegramAdminBot();
export default telegramAdminBot;