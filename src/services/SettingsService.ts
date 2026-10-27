import { join } from "path";
import { existsSync } from "fs";

let db: any = null;

function getDb() {
  if (db) return db;
  const Database = require("better-sqlite3");
  const path = join(process.cwd(), ".eliza", "settings.db");
  if (!existsSync(join(process.cwd(), ".eliza"))) {
    require("fs").mkdirSync(join(process.cwd(), ".eliza"), { recursive: true });
  }
  db = new Database(path);
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  return db;
}

export function getSetting(key: string): string | null {
  try {
    const d = getDb();
    const row = d.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : null;
  } catch (e) {
    return null;
  }
}

export function setSetting(key: string, value: string): boolean {
  try {
    const d = getDb();
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    return true;
  } catch (e) {
    console.error("setSetting error:", e);
    return false;
  }
}

export function getAllSettings(): Record<string, string | null> {
  const keys = [
    "llm_base_url",
    "llm_model",
    "llm_api_key",
    "dry_run",
    "max_trade_size_sol",
    "default_tp_pct",
    "default_stop_pct",
    "default_clock_sec",
  ];
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    result[key] = getSetting(key);
  }
  return result;
}

export function upsertSettings(pairs: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(pairs)) {
    if (!setSetting(key, value)) {
      return false;
    }
  }
  return true;
}