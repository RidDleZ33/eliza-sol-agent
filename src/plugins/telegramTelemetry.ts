// Create a light plugin: src/plugins/telegramTelemetry.ts
import { Plugin, IAgentRuntime, Memory } from "@elizaos/core";

export const telegramTelemetryPlugin: Plugin = {
  name: "telegram-telemetry",
  description: "Passively broadcasts internal war room DB logs to a Telegram channel",
  services: [
    {
      async initialize(runtime: IAgentRuntime) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_TELEMETRY_CHAT_ID;
        if (!botToken || !chatId) return;

        // Hook into internal message creation in the DB room
        runtime.subscribeEvent("MESSAGE_RECEIVED", async (memory: Memory) => {
          if (memory.roomId !== process.env.WAR_ROOM_ID) return;

          const text = `<b>[${runtime.character.name}]</b>\n${memory.content.text}`;

          // Non-blocking fetch dispatch
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: text,
              parse_mode: "HTML",
              disable_web_page_preview: true
            })
          }).catch(err => console.error("Telemetry push failed:", err));
        });
      }
    }
  ]
};