// Standalone backtest worker process.
// Usage: bun src/tape/backtest-worker.ts <recipe_id> [window_hours]
// Loads a recipe by id, compiles it, runs the backtest, writes JSON result to stdout.

import { runBacktest } from "./backtest.ts";
import { loadRecipeById } from "../recipes/db.ts";
import { compileRecipe } from "../recipes/compile.ts";

const recipeId = process.argv[2];
const windowHours = parseInt(process.argv[3] || "6", 10);
const verbose = process.argv[4] === "1" || process.argv[4] === "true";
let overridesArg = process.argv[5];
let overrides = null;
if (overridesArg) {
  try {
    overrides = JSON.parse(overridesArg);
  } catch (e: any) {
    console.log(JSON.stringify({ ok: false, error: "invalid overrides JSON: " + e.message }));
    process.exit(1);
  }
}

try {
  if (!recipeId) {
    console.log(JSON.stringify({ ok: false, error: "recipe not found" }));
    process.exit(1);
  }

  const loaded = loadRecipeById(recipeId);
  if (!loaded) {
    console.log(JSON.stringify({ ok: false, error: "recipe not found" }));
    process.exit(1);
  }

  const compiled = compileRecipe(loaded.recipe);

  // Sweep mode: overrides is an array of override objects
  if (Array.isArray(overrides)) {
    const runs: any[] = [];
    for (const ov of overrides) {
      const result = await runBacktest(compiled, windowHours, verbose, ov);
      runs.push({ overrides: ov, ...result });
    }
    // Sort by median descending
    runs.sort((a, b) => b.median - a.median);
    console.log(JSON.stringify({ ok: true, sweep: true, runs }));
  } else {
    const result = await runBacktest(compiled, windowHours, verbose, overrides);
    console.log(JSON.stringify({ ok: true, result }));
  }
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
