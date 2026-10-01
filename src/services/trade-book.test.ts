import { join } from "path";
import Database from "better-sqlite3";
import { existsSync } from "fs";

// Unique test DB per run
const TEST_DB = join(__dirname, `test_book_${Date.now()}.db`);

describe("trade book aggregation", () => {
  let db: Database.Database;
  let trips: any[] = [];

  function classifyExit(reason: string | null): string {
    if (!reason) return "OTHER";
    const upper = reason.toUpperCase();
    if (upper.startsWith("TRAILING_STOP")) return "TRAILING_STOP";
    if (upper.startsWith("STOP") || upper.includes("STOP_LOSS")) return "STOP";
    if (upper.startsWith("TAKE_PROFIT")) return "TAKE_PROFIT";
    if (upper.startsWith("STALE")) return "STALE";
    return "OTHER";
  }

  function classifyPaSrc(reason: string | null, buyReason: string | null): string {
    const combined = [reason, buyReason].filter(Boolean).join(" ");
    if (/src=birdeye/i.test(combined)) return "birdeye";
    if (/src=dex/i.test(combined)) return "dex";
    if (/PA unavailable/i.test(combined)) return "none";
    return "unk";
  }

  function holdBucket(secs: number): string {
    if (secs < 60) return "<1m";
    if (secs < 600) return "1–10m";
    if (secs < 3600) return "10–60m";
    return ">60m";
  }

  beforeAll(() => {
    if (existsSync(TEST_DB)) {
      try { Bun.rm(TEST_DB); } catch {}
    }
    db = new Database(TEST_DB);
    db.pragma("journal_mode = WAL");

    db.exec(`CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, symbol TEXT,
      side TEXT NOT NULL, sol_in REAL, sol_out REAL, reason TEXT, created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE watched_tokens (
      mint_address TEXT PRIMARY KEY, symbol TEXT, added_by_agent TEXT
    )`);

    const now = Date.now();
    const ins = db.prepare(`INSERT INTO trades (mint, symbol, side, sol_in, sol_out, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insW = db.prepare(`INSERT INTO watched_tokens VALUES (?, ?, ?)`);

    // Trip 1: dex + trailing stop, +0.3 SOL, 2min hold
    insW.run("mint1", "TRIP1", "ds_boost");
    ins.run("mint1", "TRIP1", "BUY", 1.0, null, "src=dex signal", now - 1000*60*5);
    ins.run("mint1", "TRIP1", "SELL", null, 1.3, "TRAILING_STOP(10%) src=dex", now - 1000*60*3);

    // Trip 2: PA unavailable + stop loss, -0.5 SOL, 5min hold
    insW.run("mint2", "TRIP2", "be_new");
    ins.run("mint2", "TRIP2", "BUY", 2.0, null, "PA unavailable", now - 1000*60*20);
    ins.run("mint2", "TRIP2", "SELL", null, 1.5, "STOP_LOSS(15%) PA unavailable", now - 1000*60*15);

    // Trip 3: ds_boost + stale exit, 0.0 SOL, 65min hold
    insW.run("mint3", "TRIP3", "ds_boost");
    ins.run("mint3", "TRIP3", "BUY", 0.5, null, "src=dex boost", now - 1000*60*100);
    ins.run("mint3", "TRIP3", "SELL", null, 0.5, "STALE(30m)", now - 1000*60*35);

    // Now aggregate
    const sells = db.prepare(`SELECT * FROM trades WHERE side = 'SELL' AND sol_out IS NOT NULL ORDER BY id ASC`).all() as any[];
    const usedBuys = new Set<number>();
    for (const sell of sells) {
      const buy = db.prepare(
        `SELECT id, sol_in, reason, created_at FROM trades
         WHERE mint = ? AND side = 'BUY' AND sol_in IS NOT NULL
           AND id < ? AND id NOT IN (${Array.from(usedBuys).join(",") || "0"})
         ORDER BY id DESC LIMIT 1`
      ).get(sell.mint, sell.id) as any;
      if (!buy) continue;
      usedBuys.add(buy.id);
      trips.push({
        pnl_sol: sell.sol_out - buy.sol_in,
        exit_fam: classifyExit(sell.reason),
        pa_src: classifyPaSrc(sell.reason, buy.reason),
        hold_secs: (sell.created_at - buy.created_at) / 1000,
      });
    }
  });

  afterAll(() => {
    if (db) db.close();
    try { Bun.rm(TEST_DB); } catch {}
  });

  test("detects 3 closed round trips", () => {
    expect(trips.length).toBe(3);
  });

  test("trip 1 (dex+trail) has positive PnL of ~0.3 SOL", () => {
    expect(trips[0].pnl_sol).toBeGreaterThan(0);
    expect(Math.abs(trips[0].pnl_sol - 0.3)).toBeLessThan(0.001);
  });

  test("trip 2 (none+stop) has negative PnL of -0.5 SOL", () => {
    expect(trips[1].pnl_sol).toBeLessThan(0);
    expect(Math.abs(trips[1].pnl_sol - (-0.5))).toBeLessThan(0.001);
  });

  test("trip 3 (boost+stale) is scratch", () => {
    expect(Math.abs(trips[2].pnl_sol)).toBeLessThan(0.001);
  });

  test("exit family classification", () => {
    expect(trips[0].exit_fam).toBe("TRAILING_STOP");
    expect(trips[1].exit_fam).toBe("STOP");
    expect(trips[2].exit_fam).toBe("STALE");
  });

  test("PA source classification", () => {
    expect(trips[0].pa_src).toBe("dex");
    expect(trips[1].pa_src).toBe("none");
  });

  test("hold bucket classification", () => {
    expect(holdBucket(trips[0].hold_secs)).toBe("1–10m");
    expect(holdBucket(trips[1].hold_secs)).toBe("1–10m");
    expect(holdBucket(trips[2].hold_secs)).toBe(">60m");
  });

  test("aggregate PnL sum", () => {
    const total = trips.reduce((s, t) => s + t.pnl_sol, 0);
    expect(Math.abs(total - (-0.2))).toBeLessThan(0.001);
  });

  test("win rate count", () => {
    const wins = trips.filter((t) => t.pnl_sol > 0).length;
    expect(wins).toBe(1);
  });
});
