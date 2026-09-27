// Main recorder loop
// Polls DexScreener every TAPE_POLL_MS (default 20s)
// Polls SOL mark every TAPE_SOL_MARK_MS (default 60s)
// Uses loop + sleep to prevent overlapping polls

import { openDb, closeDb, getDb } from "./db";
import { SCHEMA_VERSION } from "./schema";
import { pollDexScreener } from "./pollers/dexscreener";
import { pollSolMark } from "./pollers/solmark";
import { initJsonl, isJsonlEnabled } from "./jsonl";

const dbPath = process.env.TAPE_DB_PATH || "data/tape/tape.sqlite";
const pollMs = parseInt(process.env.TAPE_POLL_MS || "20000", 10);
const solMarkMs = parseInt(process.env.TAPE_SOL_MARK_MS || "60000", 10);

let runId = 0;
let tickCount = 0;
let firstSeenCount = 0;
let trendingCount = 0;
let errorCount = 0;
let lastSolMark = Date.now();
let lastPoll = Date.now() - pollMs;
let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGitSha(): string | null {
  try {
    const cp = require("child_process");
    const result = cp.execSync("git rev-parse --short HEAD 2>/dev/null", {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sha = result.toString().trim();
    if (sha.length > 0) return sha;
  } catch {
    // ignore
  }
  return null;
}

async function start() {
  openDb(dbPath);
  const db = getDb();

  // Get actual journal mode for startup honesty
  const journalRow = db.prepare("PRAGMA journal_mode").get();
  const actualJournalMode = journalRow.journal_mode;

  initJsonl();

  console.log(
    `[tape] schema_version=${SCHEMA_VERSION} db=${dbPath} journal=${actualJournalMode} ` +
    `jsonl=${isJsonlEnabled() ? "on" : "off"} poll_ms=${pollMs}`
  );

  // Register ingest run
  const now = Date.now();
  const gitSha = getGitSha();
  const configObj = {
    poll_ms: pollMs,
    sol_mark_ms: solMarkMs,
    jsonl: isJsonlEnabled(),
    dexscreener_host: "api.dexscreener.com",
  };

  const stmt = db.prepare(`
    INSERT INTO ingest_runs (started_at, started_at_ms, hostname, git_sha, schema_version, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    new Date(now).toISOString(),
    now,
    require("os").hostname(),
    gitSha,
    SCHEMA_VERSION,
    JSON.stringify(configObj)
  );
  runId = db.prepare("SELECT last_insert_rowid() as rid").get().rid;

  console.log(`[tape] ingest_run_id=${runId}`);

  // Initial SOL mark poll
  await pollSolMark();
  lastSolMark = Date.now();

  // Run loop
  while (running) {
    const now2 = Date.now();

    // SOL mark poller (every solMarkMs)
    if (now2 - lastSolMark >= solMarkMs) {
      await pollSolMark();
      lastSolMark = Date.now();
    }

    // Main poller (every pollMs)
    if (now2 - lastPoll >= pollMs) {
      lastPoll = Date.now();

      const result = await pollDexScreener(runId);
      tickCount += result.ticks;
      firstSeenCount += result.firstSeen;
      trendingCount += result.trending;
      errorCount += result.errors;

      console.log(`[tape] poll ticks=${result.ticks} firstSeen=${result.firstSeen} trending=${result.trending} errors=${result.errors} totalTicks=${tickCount}`);

      // Self-check after first successful poll
      if (tickCount === 0 && result.ticks === 0 && now2 - now > pollMs * 3) {
        console.log("[tape] WARNING: no ticks recorded after 3 polls");
        const row = db.prepare("SELECT COUNT(*) as cnt FROM market_ticks").get();
        console.log(`[tape] market_ticks count: ${row.cnt}`);
      }
    }

    // Sleep for a short interval
    await sleep(1000);
  }

  // Cleanup
  try {
    db.prepare("UPDATE ingest_runs SET stopped_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      runId
    );
  } catch {
    // ignore
  }

  // Backup on shutdown
  try {
    const fs = require("fs");
    const path = require("path");

    // Checkpoint WAL first
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // ignore
    }

    const backupsDir = "data/tape/backups";
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const backupPath = path.join(backupsDir, `tape-${new Date().toISOString().split("T")[0]}.sqlite`);
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[tape] backup saved to ${backupPath}`);
  } catch (err: any) {
    console.log(`[tape] backup failed: ${err.message}`);
  }

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