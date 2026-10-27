import { Hono } from "hono";
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export const referralRouter = new Hono();

const DB_DIR = join(__dirname, "../../.eliza");
const DB_PATH = join(DB_DIR, "users.db");

function getUsersDb() {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      referral_code TEXT,
      referred_by TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return d;
}

// Ensure operator row exists (stub single-tenant user)
function ensureOperator(): Database.Database {
  const d = getUsersDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO users (id, referral_code, expires_at, created_at, updated_at)
    VALUES ('operator', 'ELIZA123', ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(now + 30 * 24 * 60 * 60 * 1000, now, now);
  return d;
}

// Stub: register another "user" so a referral code exists to activate
function ensureReferralTarget(): void {
  const d = getUsersDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO users (id, referral_code, expires_at, created_at, updated_at)
    VALUES ('referral_target', 'FRIEND99', ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(now + 30 * 24 * 60 * 60 * 1000, now, now);
  d.close();
}

referralRouter.post("/activate", async (c) => {
  const body = await c.req.json();
  const code = body.code;

  if (!code) {
    return c.json({ ok: false, error: "missing 'code'" }, 400);
  }

  ensureReferralTarget();
  const d = ensureOperator();

  try {
    // Check if code matches another user
    const target = d.prepare("SELECT id FROM users WHERE referral_code = ? AND id != 'operator'").get(code);
    if (!target) {
      return c.json({ ok: false, error: "invalid referral code" }, 404);
    }

    // Check if already activated
    const operator = d.prepare("SELECT referred_by, expires_at FROM users WHERE id = 'operator'").get();
    if (operator.referred_by) {
      // Idempotent: already activated
      return c.json({ ok: true, already_activated: true, expires_at: new Date(operator.expires_at).toISOString() });
    }

    // Activate: set referred_by and extend expiry by 7 days
    const now = Date.now();
    const newExpiry = operator.expires_at + 7 * 24 * 60 * 60 * 1000;
    d.prepare("UPDATE users SET referred_by = ?, expires_at = ?, updated_at = ? WHERE id = 'operator'")
      .run(target.id, newExpiry, now);

    return c.json({
      ok: true,
      activated: true,
      referred_by: target.id,
      expires_at: new Date(newExpiry).toISOString(),
      extended_by_days: 7,
    });
  } finally {
    d.close();
  }
});

referralRouter.get("/status", (c) => {
  const d = ensureOperator();
  try {
    const operator = d.prepare("SELECT referred_by, expires_at FROM users WHERE id = 'operator'").get();
    return c.json({
      ok: true,
      referred_by: operator.referred_by,
      expires_at: new Date(operator.expires_at).toISOString(),
    });
  } finally {
    d.close();
  }
});
