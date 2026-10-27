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
  prompt: string | Array<{ role: string; content: string }>,
  options?: { json?: boolean; temperature?: number; base_url?: string; api_key?: string; model?: string }
): Promise<LlmClientResult> {
  const start = Date.now();
  let attempt = 0;
  const baseUrl = options?.base_url || BASE_URL;
  const apiKey = options?.api_key || API_KEY;
  const model = options?.model || MODEL;

  while (attempt <= 1) {
    attempt++;
    try {
      const messages = typeof prompt === "string"
        ? [{ role: "user", content: prompt }]
        : prompt;
      const body: Record<string, unknown> = {
        model: model,
        messages: messages,
        temperature: options?.temperature ?? 0.2,
      };
      if (options?.json) {
        body.response_format = { type: "json_object" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
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
      logger.info("LLM", "LlmClient", "completion", { model, latency_ms, attempt, ok: true });
      return {
        raw: content,
        parsed: tryParse(content),
        latency_ms,
      };
    } catch (e: any) {
      const latency_ms = Date.now() - start;
      if (attempt === 1) {
        logger.warn("LLM", "LlmClient", "retrying after error", { model, latency_ms, error: e.message });
        continue;
      }
      logger.error("LLM", "LlmClient", "completion failed", { model, latency_ms, error: e.message });
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
