// Standalone backtest worker process.
// Usage: bun src/tape/backtest-worker.ts <recipe_id> [window_hours]
// Loads a recipe by id, compiles it, runs the backtest, writes JSON result to stdout.

import { runBacktest } from "./backtest.ts";
import { loadRecipeById } from "../recipes/db.ts";
import { compileRecipe } from "../recipes/compile.ts";

const recipeId = process.argv[2];
const windowHours = parseInt(process.argv[3] || "6", 10);

try {
  if (!recipeId) {
    console.log(JSON.stringify({ ok: false, error: "recipe not found" }));
    process.exit(1);
  }

  const recipe = loadRecipeById(recipeId);
  if (!recipe) {
    console.log(JSON.stringify({ ok: false, error: "recipe not found" }));
    process.exit(1);
  }

  const compiled = compileRecipe(recipe);
  const result = await runBacktest(compiled, windowHours);
  console.log(JSON.stringify({ ok: true, result }));
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
