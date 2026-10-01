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
  const upper = reason.toUpperCase();
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

function classifyIngest(addedBy: string | null | undefined): string {
  if (!addedBy) return "unk";
  if (addedBy.includes("ds_boost")) return "ds_boost";
  if (addedBy.includes("be_new")) return "be_new";
  if (addedBy.includes("trader")) return "trader";
  if (addedBy.includes("trending")) return "trending";
  return addedBy;
}

function holdBucket(secs: number): string {
  if (secs < 60) return "<1m";
  if (secs < 600) return "1–10m";
  if (secs < 3600) return "10–60m";
  return ">60m";
}

function bucketLine(label: string, buckets: Map<string, { n: number; pnl: number }>): string {
  let s = `${label}  `;
  for (const [key, val] of buckets) {
    const sign = val.pnl >= 0 ? "+" : "";
    s += `${key} n=${val.n} pnl=${sign}${val.pnl.toFixed(2)}  `;
  }
  return s.trim();
}

export function aggregateBook(hoursBack: number | null): {
  trips: ClosedTrip[];
  lines: string[];
} {
  const db = watchlistService.getDb();

  // SQL: pair each SELL on a mint with the most recent prior unfilled BUY on same mint.
  // Walk sells, find matching buy, mark buy as used.
  const sells = db.prepare(
    `SELECT id, mint, symbol, side, sol_in, sol_out, reason, created_at
     FROM trades
     WHERE side = 'SELL' AND sol_out IS NOT NULL
     ORDER BY created_at ASC`
  ).all() as any[];

  const trips: ClosedTrip[] = [];
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

    const pnl = sell.sol_out - buy.sol_in;
    const holdSecs = (sell.created_at - buy.created_at) / 1000;

    // Look up ingest source from watched_tokens
    const watched = db.prepare("SELECT added_by_agent FROM watched_tokens WHERE mint_address = ? LIMIT 1").get(sell.mint);

    trips.push({
      buy_at: buy.created_at,
      sell_at: sell.created_at,
      sol_in: buy.sol_in,
      sol_out: sell.sol_out,
      pnl_sol: pnl,
      exit_fam: classifyExit(sell.reason),
      pa_src: classifyPaSrc(sell.reason, buy.reason),
      ingest: classifyIngest(watched?.added_by_agent),
      symbol: sell.symbol || "",
      mint: sell.mint,
    });
  }

  // Filter by time if requested
  let filtered = trips;
  if (hoursBack !== null) {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    filtered = trips.filter((t) => t.sell_at >= cutoff);
  }

  const lines: string[] = [];

  if (filtered.length === 0) {
    lines.push("BOOK empty");
    return { trips: filtered, lines };
  }

  // Totals
  const totalPnl = filtered.reduce((s, t) => s + t.pnl_sol, 0);
  const wins = filtered.filter((t) => t.pnl_sol > 0).length;
  const wr = (wins / filtered.length) * 100;
  const sign = totalPnl >= 0 ? "+" : "";
  lines.push(
    `BOOK n=${filtered.length}  pnl=${sign}${totalPnl.toFixed(2)} SOL  wr=${wr.toFixed(0)}%`
  );

  // By exit family
  const exitBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of filtered) {
    const b = exitBuckets.get(t.exit_fam) || { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.pnl_sol;
    exitBuckets.set(t.exit_fam, b);
  }
  lines.push(bucketLine("by exit", exitBuckets));

  // By PA source
  const paBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of filtered) {
    const b = paBuckets.get(t.pa_src) || { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.pnl_sol;
    paBuckets.set(t.pa_src, b);
  }
  lines.push(bucketLine("by pa", paBuckets));

  // By ingest source
  const ingestBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of filtered) {
    const b = ingestBuckets.get(t.ingest) || { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.pnl_sol;
    ingestBuckets.set(t.ingest, b);
  }
  lines.push(bucketLine("by src", ingestBuckets));

  // By hold bucket
  const holdBuckets = new Map<string, { n: number; pnl: number }>();
  for (const t of filtered) {
    const key = holdBucket((t.sell_at - t.buy_at) / 1000);
    const b = holdBuckets.get(key) || { n: 0, pnl: 0 };
    b.n++;
    b.pnl += t.pnl_sol;
    holdBuckets.set(key, b);
  }
  lines.push(bucketLine("by hold", holdBuckets));

  return { trips: filtered, lines };
}
