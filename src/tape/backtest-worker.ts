// Standalone backtest worker process.
// Usage: bun src/tape/backtest-worker.ts <window_hours>
// Reads tape, runs backtest, writes JSON result to stdout, exits.
// Spawning this in a separate process keeps the main event loop responsive.

import { runBacktest } from "./backtest.ts";

const windowHours = parseInt(process.argv[2] || "6", 10);

try {
  const result = await runBacktest(windowHours);
  console.log(JSON.stringify({ ok: true, result }));
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}