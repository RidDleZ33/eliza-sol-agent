import { Hono } from "hono";
import { RecipeSchema } from "../recipes/schema.ts";
import { upsertRecipe, setRecipeStatus } from "../recipes/db.ts";
import { recipesEvaluator } from "../services/RecipesEvaluator.ts";
import { can } from "../entitlements/tier.ts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const app = new Hono();

// Auth middleware: if WEB_TOKEN is set, require Bearer header. Otherwise open on 127.0.0.1 only.
const WEB_TOKEN = process.env.WEB_TOKEN;
app.use("*", (c, next) => {
  if (WEB_TOKEN) {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${WEB_TOKEN}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
  }
  return next();
});

// Health
app.get("/health", (c) => {
  return c.json({ ok: true, ts: Date.now() });
});

// Strategies list
app.get("/strategies", (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  try {
    const db = join(process.cwd(), ".eliza", "recipes.db");
    if (!existsSync(db)) {
      return c.json({ ok: true, strategies: [] });
    }
    const Database = require("better-sqlite3");
    const d = new Database(db);
    const rows = d.prepare("SELECT id, name, status, updated_at FROM strategies ORDER BY updated_at DESC").all();
    d.close();
    return c.json({ ok: true, strategies: rows });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Create strategy
app.post("/strategies", async (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  const body = await c.req.json();
  const result = RecipeSchema.safeParse(body);
  if (!result.success) {
    return c.json({ ok: false, error: result.error.errors }, 400);
  }
  try {
    upsertRecipe(`recipe:${body.name}`, body, "draft");
    return c.json({ ok: true, id: `recipe:${body.name}`, status: "draft" });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Get strategy
app.get("/strategies/:id", (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  const id = c.req.param("id");
  try {
    const db = join(process.cwd(), ".eliza", "recipes.db");
    if (!existsSync(db)) {
      return c.json({ ok: false, error: "database not found" }, 404);
    }
    const Database = require("better-sqlite3");
    const d = new Database(db);
    const row = d.prepare("SELECT id, name, status, created_at, updated_at, recipe_json FROM strategies WHERE id = ?").get(id);
    d.close();
    if (!row) {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    row.recipe = JSON.parse(row.recipe_json);
    delete row.recipe_json;
    return c.json({ ok: true, strategy: row });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Enable strategy
app.post("/strategies/:id/enable", (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  const id = c.req.param("id");
  try {
    setRecipeStatus(id, "enabled");
    recipesEvaluator.restartMatching();
    return c.json({ ok: true, id, status: "enabled" });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Disable strategy
app.post("/strategies/:id/disable", (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  const id = c.req.param("id");
  try {
    setRecipeStatus(id, "draft");
    recipesEvaluator.restartMatching();
    return c.json({ ok: true, id, status: "draft" });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Backtest
app.post("/backtest", async (c) => {
  if (!can("run_backtest")) {
    return c.json({ ok: false, error: "requires run_backtest entitlement" }, 403);
  }
  const body = await c.req.json();
  try {
    const { runBacktest } = await import("../tape/backtest.ts");
    const result = await runBacktest(body.window_hours);
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Swarm status
app.get("/swarm/status", (c) => {
  return c.json({
    ok: true,
    matching: recipesEvaluator.isMatching(),
    recipes_enabled: recipesEvaluator.getEnabledCount(),
    dry_run: process.env.DRY_RUN === "1",
  });
});

app.post("/swarm/start", (c) => {
  try {
    recipesEvaluator.startMatching();
    return c.json({ ok: true, matching: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post("/swarm/stop", (c) => {
  try {
    recipesEvaluator.stopMatching();
    return c.json({ ok: true, matching: false });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post("/swarm/restart", (c) => {
  try {
    recipesEvaluator.restartMatching();
    return c.json({ ok: true, matching: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Logs tail
app.get("/logs/tail", (c) => {
  const n = parseInt(c.req.query("n") || "100", 10);
  try {
    const logPath = join(process.cwd(), "swarm.log");
    if (!existsSync(logPath)) {
      return c.json({ ok: true, lines: [] });
    }
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    const tail = lines.slice(-n).join("\n");
    return c.json({ ok: true, lines: tail });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
