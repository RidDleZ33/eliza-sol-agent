// Main recorder loop
// Polls DexScreener every TAPE_POLL_MS (default 20s)
// Polls SOL mark every TAPE_SOL_MARK_MS (default 60s)
// Handles SIGTERM gracefully

import { openDb, closeDb, getDb } from "./db";
import { SCHEMA_VERSION } from "./schema";
import { pollDexScreener, recordError } from "./pollers/dexscreener";
import { pollSolMark } from "./pollers/solmark";

const dbPath = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";
const pollMs = parseInt(process.env.TAPE_POLL_MS || "20000", 10);
const solMarkMs = parseInt(process.env.TAPE_SOL_MARK_MS || "60000", 10);
const jsonl = process.env.TAPE_JSONL === "1";

let running = true;
let runId = 0;
let tickCount = 0;
let firstSeenCount = 0;
let trendingCount = 0;
let errorCount = 0;

async function start() {
  console.log(`[tape] schema_version=${SCHEMA_VERSION} db=${dbPath} poll_ms=${pollMs}`);

  openDb(dbPath);
  const db = getDb();

  // Register ingest run
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO ingest_runs (started_at, started_at_ms, hostname, schema_version, config_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    new Date(now).toISOString(),
    now,
    require("os").hostname(),
    SCHEMA_VERSION,
    JSON.stringify({ poll_ms: pollMs, sol_mark_ms: solMarkMs })
  );
  const runRow = db.prepare("SELECT last_insert_rowid() as rid").get();
  runId = runRow.rid;

  console.log(`[tape] ingest_run_id=${runId}`);

  // SOL mark poller (every 60s)
  let lastSolMark = 0;
  setInterval(async () => {
    if (!running) return;
    await pollSolMark();
    lastSolMark = Date.now();
  }, solMarkMs);

  // Main poller (every pollMs)
  let lastPoll = 0;
  let pollInterval = setInterval(async () => {
    if (!running) return;
    lastPoll = Date.now();

    const result = await pollDexScreener(runId);
    tickCount += result.ticks;
    firstSeenCount += result.firstSeen;
    trendingCount += result.trending;
    errorCount += result.errors;

    console.log(`[tape] poll ticks=${result.ticks} firstSeen=${result.firstSeen} trending=${result.trending} errors=${result.errors} totalTicks=${tickCount}`);

    // Self-check: after first successful poll, verify we have data
    if (tickCount === 0 && result.ticks === 0 && Date.now() - now > pollMs * 3) {
      console.log("[tape] WARNING: no ticks recorded after 3 polls");
      const row = db.prepare("SELECT COUNT(*) as cnt FROM market_ticks").get();
      console.log(`[tape] market_ticks count: ${row.cnt}`);
    }
  }, pollMs);

  // SIGTERM handler
  process.on("SIGTERM", () => {
    console.log("[tape] SIGTERM received, shutting down...");
    running = false;
    clearInterval(pollInterval);
    // Stop current poll if in progress (best effort)
    setTimeout(() => {
      db.prepare("UPDATE ingest_runs SET stopped_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        runId
      );
      closeDb();
      console.log("[tape] stopped");
      process.exit(0);
    }, 1000);
  });

  process.on("SIGINT", () => {
    console.log("[tape] SIGINT received, shutting down...");
    running = false;
    clearInterval(pollInterval);
    setTimeout(() => {
      db.prepare("UPDATE ingest_runs SET stopped_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        runId
      );
      closeDb();
      console.log("[tape] stopped");
      process.exit(0);
    }, 1000);
  });
}

start().catch((err) => {
  console.error("[tape] fatal:", err);
  process.exit(1);
});
