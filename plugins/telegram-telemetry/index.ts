import { Plugin, IAgentRuntime } from "@elizaos/core";

export const telegramTelemetryPlugin: Plugin = {
  name: "telegram-telemetry",
  version: "1.0.0",
  description: "Passively broadcasts internal war room DB logs to a Telegram channel",
  services: [
    {
      async initialize(runtime: IAgentRuntime) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_TELEMETRY_CHAT_ID;

        if (!botToken || !chatId) {
          console.log("[TELEGRAM] TELEGRAM_BOT_TOKEN or TELEGRAM_TELEMETRY_CHAT_ID not set, skipping");
          return;
        }

        console.log("[TELEGRAM] Telemetry plugin initialized for", chatId);

        // Subscribe to the war room channel
        const warRoomId = process.env.WAR_ROOM_ID || "default-warmroom";
        const channel = runtime.getRoom(warRoomId);
        if (!channel) return;

        channel.subscribe(async (message) => {
          const agentName = message.author?.name || "system";
          const text = `<b>[${agentName}]</b>\n${message.text}`;

          // Non-blocking fetch dispatch
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: "HTML",
                disable_web_page_preview: true
              })
            });
          } catch (err) {
            console.error("Telemetry push failed:", err);
          }
        });
      }
    }
  ]
};