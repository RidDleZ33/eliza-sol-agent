import { env } from "../utils/env.ts";
import { logger } from "../services/LoggerService.ts";

const BASE_URL = env.OPENAI_BASE_URL || env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const API_KEY = env.OPENAI_API_KEY || env.OLLAMA_API_KEY || "ollama";
const MODEL = env.MODEL_NAME || "Qwen2.5:3b";
const TIMEOUT_MS = 25000;

export interface LlmClientResult {
  raw: string;
  parsed: unknown | null;
  latency_ms: number;
}

function stripJsonFence(text: string): string {
  let s = text.trim();
  if (s.startsWith("```json")) {
    s = s.slice(7);
  }
  if (s.startsWith("```")) {
    s = s.slice(3);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, -3);
  }
  return s.trim();
}

export async function llmComplete(
  prompt: string,
  options?: { json?: boolean; temperature?: number }
): Promise<LlmClientResult> {
  const start = Date.now();
  let attempt = 0;

  while (attempt <= 1) {
    attempt++;
    try {
      const body: Record<string, unknown> = {
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: options?.temperature ?? 0.2,
      };
      if (options?.json) {
        body.response_format = { type: "json_object" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok && res.status < 500) {
        throw new Error(`LLM HTTP ${res.status}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      const latency_ms = Date.now() - start;
      logger.info("LLM", "LlmClient", "completion", { model: MODEL, latency_ms, attempt, ok: true });
      return {
        raw: content,
        parsed: tryParse(content),
        latency_ms,
      };
    } catch (e: any) {
      const latency_ms = Date.now() - start;
      if (attempt === 1) {
        logger.warn("LLM", "LlmClient", "retrying after error", { model: MODEL, latency_ms, error: e.message });
        continue;
      }
      logger.error("LLM", "LlmClient", "completion failed", { model: MODEL, latency_ms, error: e.message });
      return { raw: "", parsed: null, latency_ms };
    }
  }

  return { raw: "", parsed: null, latency_ms: Date.now() - start };
}

function tryParse(content: string): unknown | null {
  try {
    return JSON.parse(stripJsonFence(content));
  } catch {
    return null;
  }
}
