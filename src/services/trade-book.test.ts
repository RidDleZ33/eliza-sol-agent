import { aggregateTrips, formatBook, classifyIngest } from "./TradeBookService.ts";

describe("trade book aggregation", () => {
  // Fixture: 3 trips
  // Trip 1: dex + trailing stop, +0.3 SOL, 2min hold
  // Trip 2: PA unavailable + stop loss, -0.5 SOL, 5min hold
  // Trip 3: ds_boost + stale exit, 0.0 SOL, 65min hold

  const now = Date.now();
  const sells = [
    {
      id: 2,
      mint: "mint1",
      symbol: "TRIP1",
      side: "SELL",
      sol_in: null,
      sol_out: 1.3,
      reason: "TRAILING_STOP(10%) src=dex",
      created_at: now - 1000 * 60 * 3,
    },
    {
      id: 4,
      mint: "mint2",
      symbol: "TRIP2",
      side: "SELL",
      sol_in: null,
      sol_out: 1.5,
      reason: "STOP_LOSS(15%) PA unavailable",
      created_at: now - 1000 * 60 * 15,
    },
    {
      id: 6,
      mint: "mint3",
      symbol: "TRIP3",
      side: "SELL",
      sol_in: null,
      sol_out: 0.5,
      reason: "STALE(30m)",
      created_at: now - 1000 * 60 * 35,
    },
  ];

  const buys = new Map<string, any[]>();
  buys.set("mint1", [
    { id: 1, mint: "mint1", side: "BUY", sol_in: 1.0, reason: "src=dex signal", created_at: now - 1000 * 60 * 5 },
  ]);
  buys.set("mint2", [
    { id: 3, mint: "mint2", side: "BUY", sol_in: 2.0, reason: "PA unavailable", created_at: now - 1000 * 60 * 20 },
  ]);
  buys.set("mint3", [
    { id: 5, mint: "mint3", side: "BUY", sol_in: 0.5, reason: "src=dex boost", created_at: now - 1000 * 60 * 100 },
  ]);

  const watchedIngest = new Map<string, string>();
  watchedIngest.set("mint1", "ds_boost");
  watchedIngest.set("mint2", "be_new");
  watchedIngest.set("mint3", "ds_boost");

  let trips: any[] = [];
  let lines: string[] = [];

  beforeAll(() => {
    trips = aggregateTrips(sells, buys, watchedIngest);
    lines = formatBook(trips);
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

  test("ingest source classification", () => {
    expect(trips[0].ingest).toBe("ds_boost");
    expect(trips[1].ingest).toBe("be_new");
  });

  test("aggregate PnL sum", () => {
    const total = trips.reduce((s, t) => s + t.pnl_sol, 0);
    expect(Math.abs(total - (-0.2))).toBeLessThan(0.001);
  });

  test("win rate count", () => {
    const wins = trips.filter((t) => t.pnl_sol > 0).length;
    expect(wins).toBe(1);
  });

  test("formatBook header has n=3 and total pnl", () => {
    expect(lines[0]).toContain("n=3");
    expect(lines[0]).toContain("pnl=-0.20 SOL");
  });

  test("formatBook has bucket lines", () => {
    expect(lines[1]).toContain("by exit");
    expect(lines[1]).toContain("TRAILING_STOP");
    expect(lines[2]).toContain("by pa");
    expect(lines[2]).toContain("dex");
    expect(lines[2]).toContain("none");
    expect(lines[3]).toContain("by src");
    expect(lines[4]).toContain("by hold");
  });
});
