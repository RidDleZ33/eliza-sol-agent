import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import type { Recipe } from "./schema.ts";
import { compileRecipe } from "./compile.ts";

const DB_DIR = join(__dirname, "../../.eliza");
const DB_PATH = join(DB_DIR, "recipes.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    if (!existsSync(DB_DIR)) {
      mkdirSync(DB_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        compiled_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }
  return db;
}

export function upsertRecipe(id: string, recipe: Recipe, status = "draft") {
  const d = getDb();
  const compiled = compileRecipe(recipe);
  const now = Date.now();
  d.prepare(
    `INSERT INTO strategies (id, name, recipe_json, compiled_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       recipe_json = excluded.recipe_json,
       compiled_json = excluded.compiled_json,
       status = excluded.status,
       updated_at = excluded.updated_at`
  ).run(
    id,
    recipe.name,
    JSON.stringify(recipe),
    JSON.stringify({ filter: compiled.filter, exits: compiled.exits, requiredFields: compiled.requiredFields }),
    status,
    now,
    now
  );
}

export function loadEnabledRecipes() {
  const d = getDb();
  const rows = d.prepare(
    `SELECT id, recipe_json, compiled_json FROM strategies WHERE status = 'enabled'`
  ).all();
  return rows.map((row: any) => ({
    id: row.id,
    recipe: JSON.parse(row.recipe_json),
    compiled: JSON.parse(row.compiled_json),
  }));
}

export function setRecipeStatus(id: string, status: string) {
  const d = getDb();
  d.prepare("UPDATE strategies SET status = ? WHERE id = ?").run(status, id);
}

export function loadRecipeById(id: string) {
  const d = getDb();
  const row = d.prepare(
    `SELECT id, recipe_json, compiled_json, status FROM strategies WHERE id = ?`
  ).get(id);
  if (!row) return null;
  return {
    id: row.id,
    recipe: JSON.parse(row.recipe_json),
    compiled: JSON.parse(row.compiled_json),
    status: row.status,
  };
}
