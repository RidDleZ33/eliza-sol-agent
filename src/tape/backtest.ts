// Thin wrapper around migration grid logic for programmatic backtest calls.
// Returns structured results instead of printing to console.

import { collectMigrationClocks, getTicksForMint } from "./migrationGrid.ts";

interface PolicyResult {
  return: number;
  hit: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function scoreFlat(ticks: any[], entryPrice: number, level: number, lastPrice: number): PolicyResult {
  for (const tick of ticks) {
    if (tick.price_usd >= entryPrice * level) {
      return { return: tick.price_usd / entryPrice - 1, hit: true };
    }
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

function scoreTrail(ticks: any[], entryPrice: number, trail: number, lastPrice: number): PolicyResult {
  const armLevel = entryPrice * 1.15;
  let armed = false;
  let peak = entryPrice;
  for (const tick of ticks) {
    if (!armed && tick.price_usd >= armLevel) {
      armed = true;
      peak = tick.price_usd;
    } else if (armed) {
      if (tick.price_usd > peak) peak = tick.price_usd;
      if (tick.price_usd <= peak * (1 - trail)) {
        return { return: tick.price_usd / entryPrice - 1, hit: true };
      }
    }
  }
  return { return: lastPrice / entryPrice - 1, hit: false };
}

export async function runBacktest(windowHours?: number) {
  const clocks = collectMigrationClocks();
  
  if (clocks.size === 0) {
    return { n: 0, policies: [] };
  }

  const policyNames = [
    { name: "flat30", level: 1.3 },
    { name: "flat50", level: 1.5 },
    { name: "trail20", trail: 0.2 },
  ];

  const results: any[] = [];

  for (const policy of policyNames) {
    const returns: number[] = [];
    let hits = 0;
    let scored = 0;

    for (const [mint, clockInfo] of clocks.entries()) {
      if (clockInfo.pairAddress === null) continue;
      
      const { entry, ticks } = getTicksForMint(mint, clockInfo.clockMs, clockInfo.pairAddress);
      if (entry === null || ticks.length === 0) continue;
      
      scored++;
      const entryPrice = entry.price_usd;
      const lastPrice = ticks[ticks.length - 1].price_usd;

      let result: PolicyResult;
      if (policy.level) {
        result = scoreFlat(ticks, entryPrice, policy.level, lastPrice);
      } else {
        result = scoreTrail(ticks, entryPrice, policy.trail!, lastPrice);
      }

      returns.push(result.return);
      if (result.hit) hits++;
    }

    if (returns.length === 0) {
      results.push({ name: policy.name, n: 0, median: null, hit_rate: null });
      continue;
    }

    const med = median(returns);
    const hitRate = (hits / returns.length) * 100;
    
    results.push({
      name: policy.name,
      n: scored,
      median: med,
      hit_rate: hitRate,
    });
  }

  return { n: clocks.size, policies: results };
}
