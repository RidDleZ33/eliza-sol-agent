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
import { INGREDIENTS } from "../recipes/ingredients.ts";
import { getSetting } from "../services/SettingsService.ts";

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
Fail closed on missing fields.

IMPORTANT: Never include a JSON code block or the full recipe in your chat reply. The UI applies the recipe directly. Reply with one or two sentences describing the change you made.`;

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
      return INGREDIENTS;

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

      // Use settings for LLM config in suggest_mutation too
      const settingsBaseUrl = getSetting("llm_base_url");
      const settingsApiKey = getSetting("llm_api_key");
      const settingsModel = getSetting("llm_model");
      const llmOpts: any = { json: true };
      if (settingsBaseUrl) llmOpts.base_url = settingsBaseUrl;
      if (settingsApiKey) llmOpts.api_key = settingsApiKey;
      if (settingsModel) llmOpts.model = settingsModel;

      const llmResult = await llmComplete(prompt, llmOpts);
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
  const { messages, recipe, strategy_id, strategies } = body;

  if (!messages || messages.length === 0) {
    return c.json({ ok: false, error: "messages required" }, 400);
  }

  // Build system prompt with strategy context
  let systemPrompt = RSB_AI_SYSTEM;

  if (strategy_id) {
    const sel = strategies?.find((s: any) => s.id === strategy_id);
    systemPrompt += `\n\nYou are editing strategy: ${sel?.name || strategy_id}. Use suggest_mutation with the current recipe as base_recipe when changing the recipe.`;
  } else {
    systemPrompt += "\n\nNo strategy is currently selected. If the user wants to create a strategy, call suggest_mutation without base_recipe and give it a clear name in the instruction.";
  }

  if (strategies && strategies.length > 0) {
    const strategyList = strategies
      .map((s: any) => `${s.id} (${s.name || s.id}, ${s.status})`)
      .join(", ");
    systemPrompt += `\n\nExisting strategies: ${strategyList}`;
  }

  systemPrompt += "\n\nTo change a recipe, call suggest_mutation with an instruction and base_recipe. To check a recipe, call validate_recipe. Do not paste the full recipe JSON in your reply; the UI applies the tool result. Name the strategy in your short reply.";

  // Build conversation with system prompt
  const conversation = [
    { role: "system", content: systemPrompt },
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

  // Read settings for LLM config
  const settingsBaseUrl = getSetting("llm_base_url");
  const settingsApiKey = getSetting("llm_api_key");
  const settingsModel = getSetting("llm_model");

  const llmOptions: any = { json: false };
  if (settingsBaseUrl) llmOptions.base_url = settingsBaseUrl;
  if (settingsApiKey) llmOptions.api_key = settingsApiKey;
  if (settingsModel) llmOptions.model = settingsModel;

  // Call LLM with tools
  llmOptions.tools = TOOLS;
  llmOptions.tool_choice = "auto";
  const result = await llmComplete(conversation as Array<{ role: string; content: string }>, llmOptions);

  // If model made tool calls, execute them
  const tool_calls = result.tool_calls;
  if (tool_calls.length > 0) {
    const tool_results = [];
    for (const tc of tool_calls) {
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = {};
      }
      try {
        const tool_result = await executeTool(tc.function.name, parsedArgs);
        tool_results.push({
          tool_call_id: tc.id,
          name: tc.function.name,
          ok: true,
          result: tool_result,
        });
      } catch (e: any) {
        tool_results.push({
          tool_call_id: tc.id,
          name: tc.function.name,
          ok: false,
          result: { ok: false, errors: [e.message] },
        });
      }
    }

    return c.json({
      ok: true,
      assistant: result.raw,
      tool_calls,
      tool_results,
      latency_ms: result.latency_ms,
    });
  }

  return c.json({
    ok: true,
    assistant: result.raw,
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
