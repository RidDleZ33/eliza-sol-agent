// Main recorder loop
// Polls DexScreener every TAPE_POLL_MS (default 20s)
// Polls SOL mark every TAPE_SOL_MARK_MS (default 60s)
// Uses loop + sleep to prevent overlapping polls

import { openDb, closeDb, getDb } from "./db";
import { SCHEMA_VERSION } from "./schema";
import { pollDexScreener } from "./pollers/dexscreener";
import { pollSolMark } from "./pollers/solmark";

const dbPath = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";
const pollMs = parseInt(process.env.TAPE_POLL_MS || "20000", 10);
const solMarkMs = parseInt(process.env.TAPE_SOL_MARK_MS || "60000", 10);

let runId = 0;
let tickCount = 0;
let firstSeenCount = 0;
let trendingCount = 0;
let errorCount = 0;
let lastSolMark = 0;
let lastPoll = 0;
let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  runId = db.prepare("SELECT last_insert_rowid() as rid").get().rid;

  console.log(`[tape] ingest_run_id=${runId}`);

  // Initial SOL mark poll
  await pollSolMark();
  lastSolMark = Date.now() - now;

  // Run loop
  while (running) {
    const elapsed = Date.now() - now;

    // SOL mark poller (every solMarkMs)
    if (elapsed - lastSolMark >= solMarkMs) {
      await pollSolMark();
      lastSolMark = elapsed;
    }

    // Main poller (every pollMs)
    if (elapsed - lastPoll >= pollMs) {
      lastPoll = elapsed;

      const result = await pollDexScreener(runId);
      tickCount += result.ticks;
      firstSeenCount += result.firstSeen;
      trendingCount += result.trending;
      errorCount += result.errors;

      console.log(`[tape] poll ticks=${result.ticks} firstSeen=${result.firstSeen} trending=${result.trending} errors=${result.errors} totalTicks=${tickCount}`);

      // Self-check after first successful poll
      if (tickCount === 0 && result.ticks === 0 && elapsed > pollMs * 3) {
        console.log("[tape] WARNING: no ticks recorded after 3 polls");
        const row = db.prepare("SELECT COUNT(*) as cnt FROM market_ticks").get();
        console.log(`[tape] market_ticks count: ${row.cnt}`);
      }
    }

    // Sleep for a short interval
    await sleep(1000);
  }

  // Cleanup
  db.prepare("UPDATE ingest_runs SET stopped_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    runId
  );
  closeDb();
  console.log("[tape] stopped");
}

process.on("SIGTERM", () => {
  console.log("[tape] SIGTERM received, shutting down...");
  running = false;
});

process.on("SIGINT", () => {
  console.log("[tape] SIGINT received, shutting down...");
  running = false;
});

start().catch((err) => {
  console.error("[tape] fatal:", err);
  process.exit(1);
});
