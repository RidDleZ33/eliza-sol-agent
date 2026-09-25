import { SCHEMA_VERSION, createSchema, seedSchemaMeta } from "./schema";

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

let db: any = null;

export function openDb(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec("BEGIN");
  createSchema(db);
  seedSchemaMeta(db);
  db.exec("COMMIT");
  return db;
}

export function getDb() {
  if (!db) throw new Error("tape db not open");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
