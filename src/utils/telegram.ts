import { Telegraf } from "telegraf";

let bot: Telegraf<any>;

function getBot(): Telegraf<any> {
  if (!bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    bot = new Telegraf(token);
  }
  return bot;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_TELEMETRY_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_TELEMETRY_CHAT_ID not set");

  const b = getBot();
  await b.telegram.sendMessage(chatId, text);
}