// Telegram utilities - uses the shared admin bot instance
import { telegramAdminBot } from "../services/TelegramAdminBot.ts";

export async function sendTelegramMessage(text: string): Promise<void> {
  await telegramAdminBot.sendToChat(text);
}