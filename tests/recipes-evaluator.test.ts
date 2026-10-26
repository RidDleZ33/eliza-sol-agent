import { describe, test, expect } from "@stdlib/testing";
import { RecipesEvaluator, type CandidateFacts } from "../src/services/RecipesEvaluator.ts";
import { compileRecipe } from "../src/recipes/compile.ts";
import { upsertRecipe, setRecipeStatus } from "../src/recipes/db.ts";
import { RecipeSchema, type Recipe } from "../src/recipes/schema.ts";

describe("RecipesEvaluator", () => {
  let evaluator: RecipesEvaluator;

  test("evaluateCandidate returns empty when matching is off", () => {
    evaluator = new RecipesEvaluator();
    // Don't start matching
    const results = evaluator.evaluateCandidate({ mint: "testmint" });
    expect(results).toEqual([]);
  });

  test("recipe with holders gate passes high holder count", () => {
    evaluator = new RecipesEvaluator();

    // Upsert a recipe requiring holders >= 500
    const recipe: Recipe = {
      version: 1,
      name: "test_holders_high",
      sources: ["mig_edge"],
      gates: [{ field: "holders", op: "gte", value: 500 }],
      exits: {},
    };
    upsertRecipe("test_holders_high", recipe);
    setRecipeStatus("test_holders_high", "enabled");

    evaluator.startMatching();

    const candidate: CandidateFacts = {
      mint: "testmint",
      symbol: "TEST",
      source: "mig_edge",
      holders: 600,
    };

    const results = evaluator.evaluateCandidate(candidate);
    evaluator.stopMatching();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].recipeId).toBe("test_holders_high");
    expect(results[0].pass).toBe(true);
  });

  test("recipe with holders gate fails low holder count", () => {
    evaluator = new RecipesEvaluator();
    evaluator.startMatching();

    const candidate: CandidateFacts = {
      mint: "testmint",
      symbol: "TEST",
      source: "mig_edge",
      holders: 100,
    };

    const results = evaluator.evaluateCandidate(candidate);
    evaluator.stopMatching();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].recipeId).toBe("test_holders_high");
    expect(results[0].pass).toBe(false);
  });

  test("missing field on required gate fails", () => {
    evaluator = new RecipesEvaluator();
    evaluator.startMatching();

    // Candidate missing holders field entirely
    const candidate: CandidateFacts = {
      mint: "testmint",
      symbol: "TEST",
      source: "mig_edge",
    };

    const results = evaluator.evaluateCandidate(candidate);
    evaluator.stopMatching();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].recipeId).toBe("test_holders_high");
    expect(results[0].pass).toBe(false);
  });

  test("compileRecipe handles all gate types", () => {
    const recipe: Recipe = {
      version: 1,
      name: "test_compile",
      sources: ["mig_edge", "ds_profile"],
      gates: [
        { field: "liq_usd", op: "gte", value: 25000 },
        { field: "holders", op: "gte", value: 500 },
        { field: "top10", op: "present" },
        { field: "creator_close", op: "present" },
      ],
      exits: { tp_pct: 50, stop_pct: 15 },
    };

    const compiled = compileRecipe(recipe);
    expect(compiled.id).toBe("recipe:test_compile");
    expect(compiled.name).toBe("test_compile");
    expect(compiled.filter.liq_min_usd).toBe(25000);
    expect(compiled.filter.holders_min).toBe(500);
    expect(compiled.filter.top10_required).toBe(true);
    expect(compiled.filter.creator_required).toBe(true);
    expect(compiled.exits.tp_pct).toBe(50);
    expect(compiled.exits.stop_pct).toBe(15);
  });

  test("evaluateOneRecipe with liquidity gates", () => {
    evaluator = new RecipesEvaluator();

    // Upsert a recipe with liq gates
    const recipe: Recipe = {
      version: 1,
      name: "test_liq_range",
      sources: ["mig_edge"],
      gates: [
        { field: "liq_usd", op: "gte", value: 25000 },
        { field: "liq_usd", op: "lte", value: 100000 },
      ],
      exits: {},
    };
    upsertRecipe("test_liq_range", recipe);
    setRecipeStatus("test_liq_range", "enabled");

    evaluator.startMatching();

    // Test within range
    const candidate1: CandidateFacts = {
      mint: "testmint",
      symbol: "TEST",
      source: "mig_edge",
      liq_usd: 50000,
    };
    let results = evaluator.evaluateCandidate(candidate1);
    let liqResult = results.find(r => r.recipeId === "test_liq_range");
    expect(liqResult?.pass).toBe(true);

    // Test too high
    const candidate2: CandidateFacts = {
      mint: "testmint",
      symbol: "TEST",
      source: "mig_edge",
      liq_usd: 150000,
    };
    results = evaluator.evaluateCandidate(candidate2);
    liqResult = results.find(r => r.recipeId === "test_liq_range");
    expect(liqResult?.pass).toBe(false);

    evaluator.stopMatching();
  });

  test("restartMatching reloads enabled count", () => {
    evaluator = new RecipesEvaluator();
    evaluator.startMatching();
    const count1 = evaluator.getEnabledCount();
    evaluator.restartMatching();
    const count2 = evaluator.getEnabledCount();
    evaluator.stopMatching();
    // Both should have same count (recipes haven't changed)
    expect(count1).toBe(count2);
  });
});