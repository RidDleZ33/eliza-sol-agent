import { Hono } from "hono";
import { RecipeSchema } from "../recipes/schema.ts";
import { upsertRecipe, setRecipeStatus } from "../recipes/db.ts";
import { recipesEvaluator } from "../services/RecipesEvaluator.ts";
import { can } from "../entitlements/tier.ts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { aiRouter } from "./ai.ts";
import { aggregateBook } from "../services/TradeBookService.ts";
import { watchlistService } from "../services/WatchlistService.ts";
import { getHouseSolBalance } from "../utils/wallet.ts";
import { isDryRun } from "../utils/env.ts";
import { loadRecipeById } from "../recipes/db.ts";
import { cuRouter } from "./cu.ts";
import { referralRouter } from "./referral.ts";
import { getSetting, setSetting, getAllSettings, upsertSettings } from "../services/SettingsService.ts";
import { INGREDIENTS } from "../recipes/ingredients.ts";

export const app = new Hono();

// Static files for UI (Bun-compatible)
const PUBLIC_DIR = join(process.cwd(), "src", "web", "public");

app.get("/", (c) => {
  return c.redirect("/ui");
});

app.get("/ui", async (c) => {
  const filePath = join(PUBLIC_DIR, "index.html");
  try {
    if (!existsSync(filePath)) {
      return c.body("Not found", 404);
    }
    const file = Bun.file(filePath);
    const arrayBuf = await file.arrayBuffer();
    return c.body(new Uint8Array(arrayBuf), 200, { "Content-Type": "text/html" });
  } catch (e: any) {
    return c.body(`Error: ${e.message}`, 500);
  }
});

app.get("/ui/*", async (c) => {
  const path = c.req.path;
  const filename = path.replace("/ui/", "");
  const filePath = join(PUBLIC_DIR, filename);
  try {
    if (!existsSync(filePath)) {
      return c.body("Not found", 404);
    }
    const file = Bun.file(filePath);
    const ext = filename.split(".").pop() || "";
    let contentType = "text/html";
    if (ext === "js") contentType = "application/javascript";
    else if (ext === "css") contentType = "text/css";
    else if (ext === "json") contentType = "application/json";
    else if (ext === "png") contentType = "image/png";
    else if (ext === "jpg" || ext === "jpeg") contentType = "image/jpeg";
    const arrayBuf = await file.arrayBuffer();
    return c.body(new Uint8Array(arrayBuf), 200, { "Content-Type": contentType });
  } catch (e: any) {
    return c.body(`Error: ${e.message}`, 500);
  }
});

// Auth middleware: if WEB_TOKEN is set, require Bearer header. Otherwise open on 127.0.0.1 only.
const WEB_TOKEN = process.env.WEB_TOKEN;
app.use("*", (c, next) => {
  if (WEB_TOKEN) {
    // Skip auth for static UI files
    if (c.req.path.startsWith("/ui/")) {
      return next();
    }
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${WEB_TOKEN}`) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
  }
  return next();
});

// Dev process management endpoints
const PIDFILE = "/tmp/ridsolbot.pid";

function getPidfileOwner() {
  try {
    if (existsSync(PIDFILE)) {
      return Number(readFileSync(PIDFILE, "utf8").trim());
    }
  } catch {}
  return null;
}

function listDeskProcesses() {
  try {
    const result = Bun.spawnSync(
      ["ps", "aux"]
    );
    const output = new TextDecoder().decode(result.stdout);
    const lines = output.split("\n").filter(
      (l) => l.includes("src/index.ts") || l.includes("backtest-worker")
    );
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return { pid: Number(parts[1]), command: line.trim() };
    });
  } catch (e) {
    console.error("listDeskProcesses error:", e);
    return [];
  }
}

app.get("/dev/processes", async (c) => {
  try {
    const pidfileOwner = getPidfileOwner();
    const processes = listDeskProcesses();
    return c.json({
      ok: true,
      current_pid: process.pid,
      pidfile_owner: pidfileOwner,
      processes: processes
        .map((p) => ({
          pid: p.pid,
          command: p.command,
          is_pidfile_owner: p.pid === pidfileOwner,
          is_current: p.pid === process.pid,
        }))
        .filter((p) => !p.command.includes("grep")),
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post("/dev/kill", async (c) => {
  try {
    const body = await c.req.json();
    const killed: number[] = [];

    if (body.all) {
      const pidfileOwner = getPidfileOwner();
      const processes = listDeskProcesses();
      for (const p of processes) {
        if (p.pid !== process.pid && p.pid !== pidfileOwner) {
          try {
            process.kill(p.pid, "SIGTERM");
            killed.push(p.pid);
          } catch {}
        }
      }
    } else if (body.pid) {
      try {
        process.kill(body.pid, "SIGTERM");
        killed.push(body.pid);
      } catch {}
    }

    return c.json({ ok: true, killed });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post("/dev/restart", async (c) => {
  try {
    const body = await c.req.json();

    // Kill all other matching processes
    if (!body.keep_others) {
      const pidfileOwner = getPidfileOwner();
      const processes = listDeskProcesses();
      for (const p of processes) {
        if (p.pid !== process.pid && p.pid !== pidfileOwner) {
          try {
            process.kill(p.pid, "SIGTERM");
          } catch {}
        }
      }
    }

    // Clear old pidfile and restart flag so next process starts fresh
    try { Bun.unlinkSync(PIDFILE); } catch {}
    try { Bun.unlinkSync("/tmp/ridsolbot_restart"); } catch {}

    // Spawn a detached shell that waits for the old process to release the port
    // then execs the desk. Sleep gives the old process time to exit and free the port.
    const cmd = "sleep 1; exec " + process.argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const child = Bun.spawn(["sh", "-c", cmd], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    child.unref();

    const resp = c.json({ ok: true, message: "restarting", shell_pid: child.pid });
    setTimeout(() => process.exit(0), 100);
    return resp;
  } catch (e: any) {
    // Spawn failed — leave current process running and report error
    return c.json({ ok: false, error: e.message }, 500);
  }
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

// Export strategy as shareable JSON
app.get("/strategies/:id/export", (c) => {
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
    const row = d.prepare("SELECT id, name, recipe_json FROM strategies WHERE id = ?").get(id);
    d.close();
    if (!row) {
      return c.json({ ok: false, error: "not found" }, 404);
    }
    const recipe = JSON.parse(row.recipe_json);
    const exported = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      name: row.name,
      recipe: recipe,
    };
    return c.json(exported);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Import strategy from shareable JSON
app.post("/strategies/import", async (c) => {
  if (!can("manage_strategies")) {
    return c.json({ ok: false, error: "requires manage_strategies entitlement" }, 403);
  }
  const body = await c.req.json();
  try {
    if (!body.recipe) {
      return c.json({ ok: false, error: "missing 'recipe' field in import payload" }, 400);
    }
    const result = RecipeSchema.safeParse(body.recipe);
    if (!result.success) {
      return c.json({ ok: false, error: result.error.errors }, 400);
    }
    const id = `recipe:${body.recipe.name}`;
    // Check if exists; if enabled and not overwrite, reject
    const db = join(process.cwd(), ".eliza", "recipes.db");
    if (existsSync(db)) {
      const Database = require("better-sqlite3");
      const d = new Database(db);
      const existing = d.prepare("SELECT status FROM strategies WHERE id = ?").get(id);
      d.close();
      if (existing && existing.status === "enabled" && !body.overwrite) {
        return c.json({ ok: false, error: "strategy already enabled; pass overwrite:true to replace" }, 400);
      }
    }
    upsertRecipe(id, body.recipe, body.overwrite ? "enabled" : "draft");
    return c.json({ ok: true, id, imported: true });
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

// Backtest (non-blocking, job polling)
const BACKTEST_JOBS = new Map<string, any>();

app.post("/backtest", async (c) => {
  if (!can("run_backtest")) {
    return c.json({ ok: false, error: "requires run_backtest entitlement" }, 403);
  }
  const body = await c.req.json();
  const jobId = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  BACKTEST_JOBS.set(jobId, { status: "running", started_at: Date.now(), progress: "" });

  // Run backtest in background task
  const windowHours = body.window_hours;
  runBacktestJob(jobId, body.recipe_id, windowHours);

  return c.json({ ok: true, job_id: jobId });
});

app.get("/backtest/:id", (c) => {
  const jobId = c.req.param("id");
  const job = BACKTEST_JOBS.get(jobId);
  if (!job) {
    return c.json({ ok: false, error: "job not found" }, 404);
  }
  return c.json({ ok: true, job: job });
});

// Cap at 6 hours for this slice (backtest reads full tape for window)
function runBacktestJob(jobId: string, recipeId: string, windowHours?: number) {
  const capped = Math.min(windowHours || 6, 6);
  (async () => {
    try {
      const proc = Bun.spawn(
        ["bun", "src/tape/backtest-worker.ts", String(recipeId), String(capped)],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
      );

      const decoder = new TextDecoder();
      let stdout = "";
      let stderr = "";

      const processLine = (line: string) => {
        if (line.startsWith("[backtest]")) {
          const job = BACKTEST_JOBS.get(jobId);
          if (job) job.progress = line;
        }
      };

      // Read stdout line by line for progress
      for await (const chunk of proc.stdout) {
        const text = decoder.decode(chunk);
        stdout += text;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) processLine(lines[i].trim());
        }
      }
      // Process any final partial line
      const finalLines = stdout.split("\n");
      const lastLine = finalLines[finalLines.length - 1];
      if (lastLine.trim()) processLine(lastLine.trim());

      for await (const chunk of proc.stderr) {
        stderr += decoder.decode(chunk);
      }

      const code = await proc.exited;
      if (code !== 0) {
        BACKTEST_JOBS.set(jobId, {
          status: "error",
          error: stderr.trim() || `worker exited ${code}`,
          completed_at: Date.now(),
        });
        return;
      }
      const parsed = JSON.parse(stdout.trim());
      if (parsed.ok) {
        BACKTEST_JOBS.set(jobId, {
          status: "complete",
          result: parsed.result,
          completed_at: Date.now(),
        });
      } else {
        BACKTEST_JOBS.set(jobId, {
          status: "error",
          error: parsed.error || "backtest failed",
          completed_at: Date.now(),
        });
      }
    } catch (e: any) {
      BACKTEST_JOBS.set(jobId, {
        status: "error",
        error: `spawn failed: ${e.message}`,
        completed_at: Date.now(),
      });
    }
  })();
}

// Tape recorder control endpoints (shell out to ./tape.sh)
function tapeCommand(cmd: string) {
  try {
    const result = Bun.spawnSync(["./tape.sh", cmd], {
      cwd: process.cwd(),
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (result.exitCode === 0) {
      return { ok: true, output: stdout || "done" };
    }
    return { ok: false, error: stderr || `tape.sh ${cmd} exited ${result.exitCode}` };
  } catch (e: any) {
    return { ok: false, error: `spawn failed: ${e.message}` };
  }
}

app.post("/dev/tape/start", (c) => {
  return c.json(tapeCommand("start"));
});

app.post("/dev/tape/stop", (c) => {
  return c.json(tapeCommand("stop"));
});

app.post("/dev/tape/restart", (c) => {
  return c.json(tapeCommand("restart"));
});

app.get("/dev/tape/status", (c) => {
  return c.json(tapeCommand("status"));
});

// Ensure tape is running at boot
function ensureTapeRunning() {
  const status = tapeCommand("status");
  if (status.ok && status.output.includes("not running")) {
    tapeCommand("start");
  }
}

ensureTapeRunning();

// Swarm status
app.get("/swarm/status", (c) => {
  return c.json({
    ok: true,
    process: "running",
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

// AI assistant routes
app.route("/ai", aiRouter);

// CU estimation routes
app.route("/cu", cuRouter);

// Referral routes
app.route("/referral", referralRouter);

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

// Book route (trade book / journal with aggregation)
app.get("/book", async (c) => {
  try {
    const windowParam = c.req.query("window") || "all";
    const strategyId = c.req.query("strategy_id");

    let hoursBack: number | null = null;
    if (windowParam === "24h") hoursBack = 24;
    else if (windowParam === "7d") hoursBack = 168;

    const { trips: allTrips } = aggregateBook(hoursBack);

    // Filter by strategy if specified
    let trips = allTrips;
    if (strategyId === "none") {
      trips = allTrips.filter((t) => !t.strategy_id);
    } else if (strategyId) {
      trips = allTrips.filter((t) => t.strategy_id === strategyId);
    }

    const n = trips.length;
    const pnlSol = trips.reduce((s, t) => s + t.pnl_sol, 0);
    const netSol = trips.reduce((s, t) => s + t.net_sol, 0);
    const wins = trips.filter((t) => t.pnl_sol > 0).length;
    const winRate = n > 0 ? (wins / n) : 0;
    const avgHoldSec = n > 0 ? trips.reduce((s, t) => s + (t.sell_at - t.buy_at) / 1000, 0) / n : 0;

    // Open positions
    const openPositions = await watchlistService.getOpenPositions().then((p) => {
      if (strategyId === "none") return p.filter((pp) => !pp.strategy_id);
      if (strategyId) return p.filter((pp) => pp.strategy_id === strategyId);
      return p;
    });

    // Bucket by exit family
    const exitBuckets = new Map<string, { n: number; pnl: number; wins: number }>();
    for (const t of trips) {
      const b = exitBuckets.get(t.exit_fam) || { n: 0, pnl: 0, wins: 0 };
      b.n++;
      b.pnl += t.pnl_sol;
      if (t.pnl_sol > 0) b.wins++;
      exitBuckets.set(t.exit_fam, b);
    }
    const byExit = Array.from(exitBuckets.entries()).map(([key, val]) => ({
      key,
      n: val.n,
      pnl: val.pnl,
      win_rate: val.n > 0 ? val.wins / val.n : 0
    }));

    // Bucket by PA source
    const sourceBuckets = new Map<string, { n: number; pnl: number; wins: number }>();
    for (const t of trips) {
      const b = sourceBuckets.get(t.pa_src) || { n: 0, pnl: 0, wins: 0 };
      b.n++;
      b.pnl += t.pnl_sol;
      if (t.pnl_sol > 0) b.wins++;
      sourceBuckets.set(t.pa_src, b);
    }
    const bySource = Array.from(sourceBuckets.entries()).map(([key, val]) => ({
      key,
      n: val.n,
      pnl: val.pnl,
      win_rate: val.n > 0 ? val.wins / val.n : 0
    }));

    // Bucket by strategy (recipe that opened position)
    const strategyBuckets = new Map<string, { n: number; pnl: number; wins: number }>();
    for (const t of trips) {
      const key = t.strategy_id || "none";
      const b = strategyBuckets.get(key) || { n: 0, pnl: 0, wins: 0 };
      b.n++;
      b.pnl += t.pnl_sol;
      if (t.pnl_sol > 0) b.wins++;
      strategyBuckets.set(key, b);
    }
    const byStrategy = Array.from(strategyBuckets.entries()).map(([key, val]) => ({
      key,
      n: val.n,
      pnl: val.pnl,
      win_rate: val.n > 0 ? val.wins / val.n : 0
    }));

    // Bucket by hold time
    function holdBucket(secs: number): string {
      if (secs < 60) return "<1m";
      if (secs < 600) return "1-10m";
      if (secs < 3600) return "10-60m";
      return ">60m";
    }
    const holdBuckets = new Map<string, { n: number; pnl: number }>();
    for (const t of trips) {
      const key = holdBucket((t.sell_at - t.buy_at) / 1000);
      const b = holdBuckets.get(key) || { n: 0, pnl: 0 };
      b.n++;
      b.pnl += t.pnl_sol;
      holdBuckets.set(key, b);
    }
    const byHold = Array.from(holdBuckets.entries()).map(([key, val]) => ({
      key,
      n: val.n,
      pnl: val.pnl
    }));

    // Trips array (most recent 200)
    const tripsOut = trips.slice(-200).map((t) => ({
      symbol: t.symbol,
      mint: t.mint,
      strategy_id: t.strategy_id || "none",
      source: t.ingest,
      exit_fam: t.exit_fam,
      pnl_sol: t.pnl_sol,
      net_sol: t.net_sol,
      hold_sec: (t.sell_at - t.buy_at) / 1000,
      buy_at: t.buy_at,
      sell_at: t.sell_at
    }));

    // Open positions array
    const openOut = openPositions.map((p) => ({
      symbol: p.symbol,
      mint: p.mint_address,
      strategy_id: p.strategy_id || "none",
      source: p.source || "",
      opened_at: p.entered_at,
      size_sol: p.amount_sol
    }));

    return c.json({
      ok: true,
      window: windowParam,
      strategy_id: strategyId,
      summary: {
        n,
        pnl_sol: pnlSol,
        net_sol: netSol,
        win_rate: winRate,
        avg_hold_sec: avgHoldSec,
        open_positions: openOut.length
      },
      by_exit: byExit,
      by_source: bySource,
      by_strategy: byStrategy,
      by_hold: byHold,
      trips: tripsOut,
      open: openOut
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Settings routes
app.get("/settings", (c) => {
  const settings = getAllSettings();
  // Mask the API key
  const masked = { ...settings };
  if (masked.llm_api_key !== null) {
    masked.llm_api_key = "set";
  }
  return c.json({ ok: true, settings: masked });
});

app.post("/settings", async (c) => {
  const body = await c.req.json();
  try {
    const pairs: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        pairs[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    const ok = upsertSettings(pairs);
    if (ok) {
      return c.json({ ok: true });
    }
    return c.json({ ok: false, error: "failed to save settings" }, 500);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Ingredients route (shared between AI tool and UI)
app.get("/ingredients", (c) => {
  return c.json({ ok: true, ingredients: INGREDIENTS });
});

// Live desk dashboard
app.get("/desk", async (c) => {
  try {
    const dryRun = isDryRun();

    // Compute all-time realized PnL from closed trips (for virtual wallet)
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    let realizedAllTime = 0;
    let realizedToday = 0;
    try {
      const book = aggregateBook(null);
      for (const t of book.trips) {
        realizedAllTime += t.net_sol;
        if (t.sell_at >= todayStart) {
          realizedToday += t.net_sol;
        }
      }
    } catch (e) {
      realizedAllTime = 0;
      realizedToday = 0;
    }

    // Wallet balance: virtual in dry-run, real in live
    let walletSol: number | null = null;
    let walletMode: string = "live";
    if (dryRun) {
      walletMode = "dry_run";
      let virtualWalletSol = 10;
      try {
        const virtualSetting = getSetting("virtual_wallet_sol");
        if (virtualSetting) {
          virtualWalletSol = parseFloat(virtualSetting);
          if (isNaN(virtualWalletSol)) virtualWalletSol = 10;
        }
      } catch (e) {
        virtualWalletSol = 10;
      }
      // Virtual wallet moves with the book: starting balance + all-time realized - deployed
      walletSol = virtualWalletSol + realizedAllTime;
    } else {
      try {
        walletSol = await getHouseSolBalance();
      } catch (e) {
        walletSol = null;
      }
    }

    // Open positions
    let openPositions = [];
    try {
      openPositions = await watchlistService.getOpenPositions(dryRun);
    } catch (e) {
      openPositions = [];
    }

    // Deployed SOL = sum of open position sizes
    let deployedSol = 0;
    for (const p of openPositions) {
      deployedSol += (p.amount_sol || 0);
    }
    const freeSol = walletSol !== null ? walletSol - deployedSol : null;

    // Build watched_tokens source map and positions strategy map
    const db = watchlistService.getDb();
    const watchedRows = db.prepare("SELECT mint_address, added_by_agent FROM watched_tokens").all() as any[];
    const sourceMap = new Map<string, string>();
    for (const r of watchedRows) {
      if (r.added_by_agent) sourceMap.set(r.mint_address, r.added_by_agent);
    }
    let positionsStrategyMap = new Map<string, string>();
    try {
      const posRows = db.prepare("SELECT mint_address, strategy_id FROM positions WHERE strategy_id IS NOT NULL").all() as any[];
      for (const r of posRows) {
        positionsStrategyMap.set(r.mint_address, r.strategy_id);
      }
    } catch (e) {
      // Older schema may not have strategy_id column
    }

    // Build buys map for pairing sells to buys (for PnL computation)
    const buyRows = db.prepare(
      `SELECT id, mint, sol_in, created_at FROM trades WHERE side = 'BUY' AND sol_in IS NOT NULL`
    ).all() as any[];
    const buys = new Map<string, any[]>();
    for (const r of buyRows) {
      if (!buys.has(r.mint)) buys.set(r.mint, []);
      buys.get(r.mint)!.push(r);
    }
    // Sort buy lists by created_at ascending
    for (const [mint, list] of buys.entries()) {
      list.sort((a, b) => a.created_at - b.created_at);
    }

    // Open positions with strategy exits, age, and source
    const positions = openPositions.map((p: any) => {
      let exits = null;
      if (p.strategy_id) {
        try {
          const recipe = loadRecipeById(p.strategy_id);
          if (recipe && recipe.recipe.exits) {
            exits = {
              tp_pct: recipe.recipe.exits.tp_pct ?? null,
              stop_pct: recipe.recipe.exits.stop_pct ?? null,
              clock_sec: recipe.recipe.exits.clock_sec ?? null,
              pool_drop_pct: recipe.recipe.exits.pool_drop_pct ?? null
            };
          }
        } catch (e) {
          exits = null;
        }
      }
      // Age: handle entered_at as seconds or milliseconds
      let ageSec = 0;
      if (p.entered_at) {
        let enteredMs: number;
        if (typeof p.entered_at === 'number') {
          enteredMs = p.entered_at < 1e12 ? p.entered_at * 1000 : p.entered_at;
        } else {
          // Text timestamp (SQLite TIMESTAMP)
          enteredMs = new Date(p.entered_at).getTime();
        }
        ageSec = Math.floor((Date.now() - enteredMs) / 1000);
      }
      const source = sourceMap.get(p.mint_address) || null;
      return {
        symbol: p.symbol || "",
        mint: p.mint_address,
        strategy_id: p.strategy_id || null,
        source: source,
        size_sol: p.amount_sol || 0,
        entry_price: p.entry_price_usd || 0,
        mark_price: p.current_price_usd || 0,
        unrealized_sol: p.unrealized_pnl_sol || 0,
        unrealized_pct: p.unrealized_pnl_pct || 0,
        age_sec: ageSec,
        tp_pct: exits?.tp_pct ?? null,
        stop_pct: exits?.stop_pct ?? null,
        clock_sec: exits?.clock_sec ?? null,
        pool_drop_pct: exits?.pool_drop_pct ?? null
      };
    });

    // Recent fills (last 20) with PnL for SELLs
    let recentFills = [];
    try {
      const rows = db.prepare(
        `SELECT id, mint, symbol, side, status, reason, created_at, sol_in, sol_out FROM trades ORDER BY id DESC LIMIT 20`
      ).all() as any[];
      // Work on a copy of buys for pairing
      const buyPairs = new Map(buys);
      for (const row of buyPairs.values()) {
        buyPairs.set(row[0].mint, [...row]);
      }
      recentFills = rows.map((r: any) => {
        let pnlSol: number | null = null;
        let strategyId: string | null = null;
        if (r.side === 'SELL' && r.sol_out !== null) {
          // Find paired buy for this mint
          const list = buyPairs.get(r.mint);
          if (list && list.length > 0) {
            let best = null;
            for (const b of list) {
              if (b.created_at < r.created_at) best = b;
              else break;
            }
            if (best) {
              pnlSol = r.sol_out - best.sol_in;
              const idx = list.indexOf(best);
              if (idx >= 0) list.splice(idx, 1);
            }
          }
        }
        // Look up strategy_id from the position (same map for buys and sells)
        strategyId = positionsStrategyMap.get(r.mint) || null;
        return {
          ts: r.created_at,
          side: r.side,
          symbol: r.symbol || "",
          mint: r.mint || "",
          strategy_id: strategyId,
          pnl_sol: pnlSol,
          reason: r.reason || ""
        };
      });
    } catch (e) {
      recentFills = [];
    }

    // Matching status
    let matchingEnabled = false;
    let recipeCount = 0;
    try {
      matchingEnabled = recipesEvaluator.isMatching();
      recipeCount = recipesEvaluator.getEnabledCount();
    } catch (e) {
      matchingEnabled = false;
      recipeCount = 0;
    }

    // Unrealized for open positions
    let unrealizedSol = 0;
    for (const p of positions) {
      unrealizedSol += p.unrealized_sol;
    }

    return c.json({
      ok: true,
      wallet: {
        sol: walletSol,
        deployed_sol: deployedSol,
        free_sol: freeSol,
        mode: walletMode
      },
      session: {
        realized_sol: realizedToday,
        unrealized_sol: unrealizedSol,
        open_count: positions.length
      },
      matching: {
        enabled: matchingEnabled,
        recipe_count: recipeCount
      },
      positions: positions,
      recent: recentFills
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});
