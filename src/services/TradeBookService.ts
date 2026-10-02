import { watchlistService } from "./WatchlistService.ts";


interface ClosedTrip {
  buy_at: number;
  sell_at: number;
  sol_in: number;
  sol_out: number;
  pnl_sol: number;
  exit_fam: string;
  pa_src: string;
  ingest: string;
  symbol: string;
  mint: string;
}

function classifyExit(reason: string | null | undefined): string {
  if (!reason) return "OTHER";
  // Strip leading [src=...] tag if present
  let r = reason.replace(/^\[[^\]]*\]\s*/, "").trim();
  // Sell reasons now written as: pnl_sol=X (FAMILY (...) | MFE ...) — extract family from first paren
  if (r.startsWith("pnl_sol=")) {
    const parenMatch = r.match(/\(\s*(\w+)/);
    if (parenMatch) {
      r = parenMatch[1];
    }
  }
  const upper = r.toUpperCase();
  if (upper.startsWith("TRAILING_STOP")) return "TRAILING_STOP";
  if (upper.startsWith("STOP") || upper.includes("STOP_LOSS")) return "STOP";
  if (upper.startsWith("TAKE_PROFIT")) return "TAKE_PROFIT";
  if (upper.startsWith("STALE")) return "STALE";
  return "OTHER";
}

function classifyPaSrc(reason: string | null | undefined, buyReason: string | null | undefined): string {
  const combined = [reason, buyReason].filter(Boolean).join(" ");
  if (/src=birdeye/i.test(combined)) return "birdeye";
  if (/src=dex/i.test(combined)) return "dex";
  if (/PA unavailable/i.test(combined)) return "none";
  return "unk";
}

export function classifyIngest(addedBy: string | null | undefined): string {
  if (!addedBy) return "unk";
  // Bucket by raw feed name stored at insert time — no whitelist, no mapping
  return addedBy.trim().replace(/\s+/g, " ");
}

function holdBucket(secs: number): string {
  if (secs < 60) return "<1m";
  if (secs < 600) return "1–10m";
  if (secs < 3600) return "10–60m";
  return ">60m";
}



export function aggregateTrips(
  sells: any[],
  buys: Map<string, any[]>,
  watchedIngest: Map<string, string>
): ClosedTrip[] {
  const trips: ClosedTrip[] = [];
  // Build per-mint buy lists sorted by created_at ascending (time, not id)
  for (const [mint, list] of buys.entries()) {
    list.sort((a, b) => {
      const at = a.created_at < 1e12 ? a.created_at * 1000 : a.created_at;
      const bt = b.created_at < 1e12 ? b.created_at * 1000 : b.created_at;
      if (at !== bt) return at - bt;
      // Same timestamp: lower id first (stable tiebreak)
      return a.id - b.id;
    });
  }
  for (const sell of sells) {
    const list = buys.get(sell.mint);
    if (!list) continue;
    // Find closest prior BUY by created_at (not id)
    const sellTs = sell.created_at < 1e12 ? sell.created_at * 1000 : sell.created_at;
    let best: any = null;
    for (const b of list) {
      const bTs = b.created_at < 1e12 ? b.created_at * 1000 : b.created_at;
      if (bTs < sellTs) best = b;
      else break;
    }
    if (!best) continue;
    // Remove from list so it's not reused
    const idx = list.indexOf(best);
    if (idx >= 0) list.splice(idx, 1);
    const buyTs = best.created_at < 1e12 ? best.created_at * 1000 : best.created_at;
    const pnl = sell.sol_out - best.sol_in;
    trips.push({
      buy_at: buyTs,
      sell_at: sellTs,
      sol_in: best.sol_in,
      sol_out: sell.sol_out,
      pnl_sol: pnl,
      exit_fam: classifyExit(sell.reason),
      pa_src: classifyPaSrc(sell.reason, best.reason),
      ingest: classifyIngest(watchedIngest.get(sell.mint) || null),
      symbol: sell.symbol || "",
      mint: sell.mint,
    });
  }
  return trips;
}

function groupLines(label: string, buckets: Map<string, { n: number; pnl: number }>): string[] {
  if (buckets.size === 0) return [];
  const out: string[] = [label];
  for (const [key, val] of buckets) {
    const sign = val.pnl >= 0 ? "+" : "";
    out.push(`  ${key}  n=${val.n}  pnl=${sign}${val.pnl.toFixed(2)}`);
  }
  return out;
}

export function formatBook(trips: ClosedTrip[]): string[] {
  if (trips.length === 0) {
    return ["BOOK empty"];
  }
  const totalPnl = trips.reduce((s, t) => s + t.pnl_sol, 0);
  const wins = trips.filter((t) => t.pnl_sol > 0).length;
  const wr = (wins / trips.length) * 100;
  const sign = totalPnl >= 0 ? "+" : "";
  const lines: string[] = [
    `BOOK  n=${trips.length}  pnl=${sign}${totalPnl.toFixed(2)} SOL  wr=${wr.toFixed(0)}%`
  ];

  const exitBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of trips) {
    const b = exitBuckets.get(t.exit_fam) || { n: 0, pnl: 0 };
    b.n++; b.pnl += t.pnl_sol;
    exitBuckets.set(t.exit_fam, b);
  }
  lines.push(...groupLines("exit", exitBuckets));

  const paBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of trips) {
    const b = paBuckets.get(t.pa_src) || { n: 0, pnl: 0 };
    b.n++; b.pnl += t.pnl_sol;
    paBuckets.set(t.pa_src, b);
  }
  lines.push(...groupLines("pa", paBuckets));

  const ingestBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of trips) {
    const b = ingestBuckets.get(t.ingest) || { n: 0, pnl: 0 };
    b.n++; b.pnl += t.pnl_sol;
    ingestBuckets.set(t.ingest, b);
  }
  lines.push(...groupLines("src", ingestBuckets));

  const holdBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of trips) {
    const key = holdBucket((t.sell_at - t.buy_at) / 1000);
    const b = holdBuckets.get(key) || { n: 0, pnl: 0 };
    b.n++; b.pnl += t.pnl_sol;
    holdBuckets.set(key, b);
  }
  lines.push(...groupLines("hold", holdBuckets));

  // Insert blank lines between groups
  const result: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] !== "" && !lines[i].startsWith("  ")) {
      result.push("");
    }
    result.push(lines[i]);
  }
  return result;
}

export function aggregateBook(hoursBack: number | null): {
  trips: ClosedTrip[];
  lines: string[];
} {
  const db = watchlistService.getDb();
  const sells = db.prepare(
    `SELECT id, mint, symbol, side, sol_in, sol_out, reason, created_at
     FROM trades
     WHERE side = 'SELL' AND sol_out IS NOT NULL
     ORDER BY created_at ASC`
  ).all() as any[];
  const buyRows = db.prepare(
    `SELECT id, mint, side, sol_in, reason, created_at
     FROM trades
     WHERE side = 'BUY' AND sol_in IS NOT NULL`
  ).all() as any[];
  const buys = new Map<string, any[]>();
  for (const r of buyRows) {
    if (!buys.has(r.mint)) buys.set(r.mint, []);
    buys.get(r.mint)!.push(r);
  }
  // watched_tokens ingest source map
  const watchedRows = db.prepare("SELECT mint_address, added_by_agent FROM watched_tokens").all() as any[];
  const watchedIngest = new Map<string, string>();
  for (const r of watchedRows) {
    if (r.added_by_agent) watchedIngest.set(r.mint_address, r.added_by_agent);
  }
  let trips = aggregateTrips(sells, buys, watchedIngest);
  // Filter by time if requested
  if (hoursBack !== null) {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    trips = trips.filter((t) => t.sell_at >= cutoff);
  }
  return { trips, lines: formatBook(trips) };
}
