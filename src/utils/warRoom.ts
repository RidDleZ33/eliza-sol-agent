import { type IAgentRuntime } from "@elizaos/core";

export const WAR_ROOM_ID = "00000000-0000-0000-0000-000000000001";

export async function ensureWarRoomJoined(runtime: IAgentRuntime): Promise<void> {
  try {
    if (runtime.databaseAdapter?.ensureRoomExists) {
      await runtime.databaseAdapter.ensureRoomExists(WAR_ROOM_ID);
    }

    // Actually call the LLM to generate a self-introduction - proves backend is warmed up
    const introPrompt = `You are ${runtime.character.name} on an AI trading committee. Briefly introduce yourself in one sentence, stating your role and that you're online and ready to evaluate Solana tokens. Be concise.`;

    let introText = `🚀 ${runtime.character.name} online.`;
    try {
      // generateText expects a string, not an object
      // Use explicit model to avoid provider defaulting to gpt-4o
      const modelOverride = process.env.OPENAI_LARGE_MODEL || "Qwen2.5:3b";
      const result = await runtime.generateText(introPrompt, modelOverride);
      // generateText returns { text: string }
      const introStr = typeof result === "object" && result?.text ? result.text : String(result || "");
      if (introStr && introStr.trim()) {
        introText = `🚀 ${introStr.trim()}`;
      }
    } catch (e) {
      runtime.logger.warn(`[WarRoom] LLM intro failed for ${runtime.character.name}, using default: ${e.message}`);
    }

    // Announce agent presence in the war room
    const channel = runtime.getRoom(WAR_ROOM_ID);
    if (channel && typeof channel.publish === "function") {
      channel.publish({
        author: { name: runtime.character.name },
        text: introText,
        timestamp: Date.now()
      });
    }

    runtime.logger.info(`[WarRoom] Agent ${runtime.character.name} attached to War Room and announced via LLM.`);
  } catch (e) {
    runtime.logger.warn(`[WarRoom] Core room lookup skipped for ${runtime.character.name}: ${e.message}`);
  }
}