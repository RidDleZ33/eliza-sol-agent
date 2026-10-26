// AI assistant tool surface for strategy building.
// Exposes OpenAI-compatible tool call endpoints that mutate/validate recipe JSON.
// Example conversation:
//   User: "add a holders >= 500 gate and a 30% TP"
//   Model calls tools: list_ingredients, validate_recipe, suggest_mutation
//   Result: updated recipe JSON appears in the editor.

import { Hono } from "hono";
import { llmComplete } from "../llm/LlmClient.ts";
import { RecipeSchema } from "../recipes/schema.ts";
import { compileRecipe } from "../recipes/compile.ts";

export const aiRouter = new Hono();

// System prompt fragment
const RSB_AI_SYSTEM = `You are inside RidSolBot (eliza-sol-agent).
Strategies are versioned recipe JSON objects with the structure:
{
  "version": 1,
  "name": "string",
  "sources": ["mig_edge" | "ds_profile" | "ds_boost" | "custom"],
  "gates": [
    {
      "field": string,
      "op": "gte" | "lte" | "eq" | "present" | "absent",
      "value": number | string | boolean (optional)
    }
  ],
  "exits": {
    "tp_pct": number,
    "stop_pct": number,
    "trail_pct": number,
    "clock_sec": number,
    "pool_drop_pct": number
  },
  "rules": [any],
  "meta": { ... }
}

Available gate fields:
- liq_usd: pool liquidity in USD
- holders: number of token holders
- top10: presence of top 10 holders data
- creator_close: presence of creator wallet info
- nuke_ratio: (future) max supply in single wallet
- pool_age_sec: seconds since pool creation
- vol_1h: 1-hour volume

Available exit keys:
- tp_pct: take-profit percentage (e.g. 30 for 30%)
- stop_pct: stop-loss percentage (e.g. 15 for 15%)
- trail_pct: trailing stop percentage
- clock_sec: max holding time in seconds
- pool_drop_pct: exit if pool liquidity drops by X%

Always validate a recipe before suggesting it be enabled.
Prefer pair-scoped tape numbers.
Do not invent live cuts that the compiler rejects.
Fail closed on missing fields.`;

// Tool definitions (OpenAI-compatible format)
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_ingredients",
      description: "List available strategy ingredients: sources, gate fields, operators, exit keys with examples.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_recipe",
      description: "Validate a recipe JSON and return compilation result.",
      parameters: {
        type: "object",
        required: ["recipe"],
        properties: {
          recipe: { type: "object", description: "Recipe JSON object" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_mutation",
      description: "Given natural language and an optional base recipe, suggest a recipe mutation (add gate, change exit).",
      parameters: {
        type: "object",
        required: ["instruction"],
        properties: {
          instruction: { type: "string", description: "Natural language instruction" },
          base_recipe: { type: "object", description: "Optional current recipe" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sample_tape",
      description: "Run a quick backtest on recent tape data using the current recipe to estimate how it would have performed. Returns n (clocks), policies with median return and hit rate.",
      parameters: {
        type: "object",
        properties: {
          window_hours: { type: "integer", description: "Optional window in hours (default 24)" },
        },
      },
    },
  },
];

// Tool executor
async function executeTool(name: string, args: any) {
  switch (name) {
    case "list_ingredients":
      return {
        sources: [
          { name: "mig_edge", desc: "Meme-in-Genesis edge case tokens" },
          { name: "ds_profile", desc: "DexScreener token profiles" },
          { name: "ds_boost", desc: "DexScreener boosted tokens" },
          { name: "custom", desc: "Custom source" },
        ],
        gate_fields: [
          { field: "liq_usd", desc: "Pool liquidity in USD", example: { field: "liq_usd", op: "gte", value: 10000 } },
          { field: "holders", desc: "Number of holders", example: { field: "holders", op: "gte", value: 500 } },
          { field: "top10", desc: "Top 10 holders present", example: { field: "top10", op: "present" } },
          { field: "creator_close", desc: "Creator wallet info present", example: { field: "creator_close", op: "present" } },
          { field: "nuke_ratio", desc: "Max supply in single wallet", example: { field: "nuke_ratio", op: "lte", value: 0.2 } },
          { field: "pool_age_sec", desc: "Seconds since pool creation", example: { field: "pool_age_sec", op: "lte", value: 3600 } },
          { field: "vol_1h", desc: "1-hour volume", example: { field: "vol_1h", op: "gte", value: 100000 } },
        ],
        operators: ["gte", "lte", "eq", "present", "absent"],
        exit_keys: [
          { key: "tp_pct", desc: "Take-profit percentage", example: 30 },
          { key: "stop_pct", desc: "Stop-loss percentage", example: 15 },
          { key: "trail_pct", desc: "Trailing stop percentage", example: 10 },
          { key: "clock_sec", desc: "Max holding time (seconds)", example: 7200 },
          { key: "pool_drop_pct", desc: "Exit on pool liquidity drop (%)", example: 50 },
        ],
      };

    case "validate_recipe": {
      const result = RecipeSchema.safeParse(args.recipe);
      if (!result.success) {
        return { ok: false, errors: result.error.errors, compiled: false };
      }
      try {
        const compiled = compileRecipe(result.data);
        return { ok: true, errors: [], compiled: true, compiled_info: { sources: compiled.sources, requiredFields: compiled.requiredFields } };
      } catch (e: any) {
        return { ok: false, errors: [{ message: e.message }], compiled: false };
      }
    }

    case "sample_tape": {
      try {
        const { runBacktest } = await import("../../tape/backtest.ts");
        const result = await runBacktest(args.window_hours);
        return {
          ok: true,
          n: result.n,
          policies: result.policies.map((p: any) => ({
            name: p.name,
            n: p.n,
            median: p.median !== null ? p.median : null,
            hit_rate: p.hit_rate !== null ? p.hit_rate : null,
          })),
        };
      } catch (e: any) {
        return { ok: false, errors: [e.message] };
      }
    }

    case "suggest_mutation": {
      // Use the LLM to suggest a mutation, then validate it
      const prompt = `${RSB_AI_SYSTEM}

Current recipe: ${args.base_recipe ? JSON.stringify(args.base_recipe) : "(none)"}

Instruction: ${args.instruction}

Suggest a complete, valid recipe JSON that implements this change. Return ONLY the JSON object.`;

      const llmResult = await llmComplete(prompt, { json: true });
      if (!llmResult.parsed) {
        return { ok: false, errors: ["LLM failed to produce JSON"], recipe: null };
      }

      // Validate the suggested recipe
      const validation = await executeTool("validate_recipe", { recipe: llmResult.parsed });
      if (!validation.ok) {
        return {
          ok: false,
          errors: [validation.errors.map((e: any) => e.message).join(", ")],
          recipe: llmResult.parsed,
        };
      }

      return {
        ok: true,
        errors: [],
        recipe: llmResult.parsed,
        explanation: `Suggested recipe based on: ${args.instruction}`,
      };
    }

    default:
      return { ok: false, errors: [`Unknown tool: ${name}`] };
  }
}

// Chat endpoint
aiRouter.post("/chat", async (c) => {
  const body = await c.req.json();
  const { messages, recipe, stream } = body;

  if (!messages || messages.length === 0) {
    return c.json({ ok: false, error: "messages required" }, 400);
  }

  // Build conversation with system prompt
  const conversation = [
    { role: "system", content: RSB_AI_SYSTEM },
    ...messages,
  ];

  // If recipe is provided, inject it into context
  if (recipe) {
    conversation.splice(1, 0, {
      role: "system",
      content: `Current recipe being edited:
${JSON.stringify(recipe, null, 2)}`,
    });
  }

  // Call LLM with tools
  const result = await llmComplete(conversation);
  
  // Check for tool calls in response (simple pattern matching for now)
  let tool_calls = [];
  let assistant_content = result.raw;
  
  // Parse tool call markers if present
  const toolCallPattern = /<tool_call>(\w+)<\/tool_call>\s*<tool_args>([\s\S]*?)<\/tool_args>/g;
  let match;
  while ((match = toolCallPattern.exec(result.raw)) !== null) {
    try {
      const toolName = match[1];
      const toolArgs = JSON.parse(match[2]);
      tool_calls.push({ name: toolName, arguments: toolArgs });
    } catch {
      // Skip malformed tool calls
    }
  }

  // Execute any tool calls
  const tool_results = [];
  for (const tc of tool_calls) {
    try {
      const tool_result = await executeTool(tc.name, tc.arguments);
      tool_results.push({
        name: tc.name,
        result: tool_result,
      });
    } catch (e: any) {
      tool_results.push({
        name: tc.name,
        result: { ok: false, errors: [e.message] },
      });
    }
  }

  // If tools were called, return the results so the UI can display them
  // and potentially send a follow-up message with the results
  if (tool_calls.length > 0) {
    return c.json({
      ok: true,
      assistant: assistant_content,
      tool_calls,
      tool_results,
    });
  }

  return c.json({
    ok: true,
    assistant: assistant_content,
    latency_ms: result.latency_ms,
  });
});

// Tools list endpoint
aiRouter.get("/tools", (c) => {
  return c.json({ ok: true, tools: TOOLS });
});

// Single tool execution endpoint
aiRouter.post("/tools/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  try {
    const result = await executeTool(name, body);
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

export default aiRouter;
