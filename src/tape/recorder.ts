// Main recorder loop
// Polls DexScreener every TAPE_POLL_MS (default 20s)
// Polls SOL mark every TAPE_SOL_MARK_MS (default 60s)
// Writes daily rolling tape files: data/tape/tape-YYYY-MM-DD.sqlite
// Prunes day files older than TAPE_RETAIN_DAYS on start and once per day.
// Legacy tape.sqlite is pruned only when its newest tick is past the window.

import { openDb, closeDb, getDb } from "./db";
import { SCHEMA_VERSION } from "./schema";

const Database = require("better-sqlite3");
import { pollDexScreener } from "./pollers/dexscreener";
import { pollSolMark } from "./pollers/solmark";
import { initJsonl, isJsonlEnabled } from "./jsonl";
import { getTapeRetainDays } from "../utils/env";
import { existsSync, unlinkSync, readdirSync } from "fs";

const TAPE_DIR = "data/tape";
const LEGACY_DB = "data/tape/tape.sqlite";
const RETAIN_DAYS = getTapeRetainDays();

const pollMs = parseInt(process.env.TAPE_POLL_MS || "20000", 10);
const solMarkMs = parseInt(process.env.TAPE_SOL_MARK_MS || "60000", 10);

let runId = 0;
let tickCount = 0;
let firstSeenCount = 0;
let trendingCount = 0;
let errorCount = 0;
let lastSolMark = Date.now();
let lastPoll = Date.now() - pollMs;
let lastPrune = Date.now();
let running = true;
let todayPath = "";

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

function dateFilename(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayFilePath(dateStr: string): string {
  return `${TAPE_DIR}/tape-${dateStr}.sqlite`;
}

function ensureDayFile(dateStr: string): string {
  const path = dayFilePath(dateStr);
  if (!existsSync(path)) {
    openDb(path);
    closeDb();
    console.log(`[tape] opened day file ${path}`);
  }
  return path;
}

async function pruneDayFiles() {
  const now = Date.now();
  const cutoff = new Date(now - RETAIN_DAYS * 86400000);
  const cutoffStr = dateFilename(cutoff);

  try {
    const files = readdirSync(TAPE_DIR).filter(
      (f: string) => f.startsWith("tape-") && f.endsWith(".sqlite")
    );

    for (const f of files) {
      const datePart = f.slice(5, 15); // YYYY-MM-DD
      if (datePart < cutoffStr) {
        const full = `${TAPE_DIR}/${f}`;
        try {
          unlinkSync(full);
          console.log(`[tape] pruned day file ${full}`);
        } catch (e: any) {
          console.log(`[tape] prune failed for ${full}: ${e.message}`);
        }
        // Unlink sidecar files if they exist (SQLite names them tape-YYYY-MM-DD.sqlite-wal)
        for (const ext of ["-wal", "-shm"]) {
          const sidecar = full + ext;
          if (existsSync(sidecar)) {
            try {
              unlinkSync(sidecar);
            } catch {
              // missing sidecar is not an error
            }
          }
        }
      }
    }
  } catch (e: any) {
    console.log(`[tape] prune list failed: ${e.message}`);
  }

  // Prune legacy file only when its newest tick is past the window
  // Use a separate connection; do not call openDb (which replaces the writer)
  if (existsSync(LEGACY_DB)) {
    let legacyConn = null;
    try {
      legacyConn = new Database(LEGACY_DB, { readonly: true });
      const row = legacyConn.prepare(
        "SELECT MAX(observed_at_ms) as newest FROM market_ticks"
      ).get();
      if (row && row.newest) {
        const newestDate = new Date(row.newest);
        if (newestDate < cutoff) {
          legacyConn.close();
          legacyConn = null;
          unlinkSync(LEGACY_DB);
          console.log(`[tape] pruned legacy file ${LEGACY_DB}`);
          // Unlink sidecar files if they exist (SQLite names them tape.sqlite-wal)
          for (const ext of ["-wal", "-shm"]) {
            const sidecar = LEGACY_DB + ext;
            if (existsSync(sidecar)) {
              try {
                unlinkSync(sidecar);
              } catch {
                // missing sidecar is not an error
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.log(`[tape] legacy prune check failed: ${e.message}`);
    } finally {
      if (legacyConn) {
        legacyConn.close();
      }
    }
  }
}

async function start() {
  const todayStr = dateFilename(new Date());
  todayPath = ensureDayFile(todayStr);
  openDb(todayPath);

  const db = getDb();
  const journalRow = db.prepare("PRAGMA journal_mode").get();
  const actualJournalMode = journalRow.journal_mode;

  initJsonl();

  console.log(
    `[tape] schema_version=${SCHEMA_VERSION} db=${todayPath} journal=${actualJournalMode} ` +
    `jsonl=${isJsonlEnabled() ? "on" : "off"} poll_ms=${pollMs} retain_days=${RETAIN_DAYS}`
  );

  // Register ingest run
  const now = Date.now();
  const gitSha = getGitSha();
  const configObj = {
    poll_ms: pollMs,
    sol_mark_ms: solMarkMs,
    jsonl: isJsonlEnabled(),
    dexscreener_host: "api.dexscreener.com",
    retain_days: RETAIN_DAYS,
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

  // Prune on start
  await pruneDayFiles();

  // Run loop
  while (running) {
    const now2 = Date.now();
    const currentDayStr = dateFilename(new Date(now2));

    // Daily file roll: if we crossed into a new day, reopen
    const dbPath = dayFilePath(currentDayStr);
    if (dbPath !== todayPath) {
      console.log(`[tape] rolling to day file ${dbPath}`);
      closeDb();
      ensureDayFile(currentDayStr);
      openDb(dbPath);
      todayPath = dbPath;
      const newDb = getDb();
      runId = 0;
      const now3 = Date.now();
      const stmt2 = newDb.prepare(`
        INSERT INTO ingest_runs (started_at, started_at_ms, hostname, git_sha, schema_version, config_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt2.run(
        new Date(now3).toISOString(),
        now3,
        require("os").hostname(),
        getGitSha(),
        SCHEMA_VERSION,
        JSON.stringify(configObj)
      );
      runId = newDb.prepare("SELECT last_insert_rowid() as rid").get().rid;
    }

    // Daily prune
    if (now2 - lastPrune >= 86400000) {
      await pruneDayFiles();
      lastPrune = now2;
    }

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
    }

    // Sleep for a short interval
    await sleep(1000);
  }

  // Cleanup
  try {
    const db = getDb();
    db.prepare("UPDATE ingest_runs SET stopped_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      runId
    );
  } catch {
    // ignore
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