import { describe, test, expect } from "bun:test";
import { RecipeSchema } from "../src/recipes/schema.ts";
import { compileRecipe } from "../src/recipes/compile.ts";

// Canonical mig_edge recipe: liq 25-100k, holders>=500, top10 present, creator present
const MIG_EDGE_RECIPE = {
  version: 1,
  name: "mig_edge",
  sources: ["mig_edge"],
  gates: [
    { field: "liq_usd", op: "gte", value: 25000 },
    { field: "liq_usd", op: "lte", value: 100000 },
    { field: "holders", op: "gte", value: 500 },
    { field: "top10", op: "present" },
    { field: "creator_close", op: "present" },
  ],
  exits: {
    tp_pct: 50,
    stop_pct: 15,
    trail_pct: 10,
    clock_sec: 0,
    pool_drop_pct: 30,
  },
  rules: [],
  meta: { description: "Majority-migration edge: pump.fun -> raydium" },
};

describe("recipe schema", () => {
  test("accepts canonical mig_edge recipe", () => {
    expect(() => RecipeSchema.parse(MIG_EDGE_RECIPE)).not.toThrow();
  });

  test("rejects missing version", () => {
    expect(() => RecipeSchema.parse({ name: "x" })).toThrow();
  });

  test("rejects unknown source", () => {
    expect(() =>
      RecipeSchema.parse({ ...MIG_EDGE_RECIPE, sources: ["unknown_source"] })
    ).toThrow();
  });

  test("rejects unknown gate op", () => {
    expect(() =>
      RecipeSchema.parse({
        ...MIG_EDGE_RECIPE,
        gates: [{ field: "x", op: "gt", value: 1 }],
      })
    ).toThrow();
  });
});

describe("compile recipe", () => {
  test("mig_edge compiles to expected filter", () => {
    const compiled = compileRecipe(MIG_EDGE_RECIPE as any);
    expect(compiled.filter.liq_min_usd).toBe(25000);
    expect(compiled.filter.liq_max_usd).toBe(100000);
    expect(compiled.filter.holders_min).toBe(500);
    expect(compiled.filter.top10_required).toBe(true);
    expect(compiled.filter.creator_required).toBe(true);
  });

  test("mig_edge compiles to expected exits", () => {
    const compiled = compileRecipe(MIG_EDGE_RECIPE as any);
    expect(compiled.exits.tp_pct).toBe(50);
    expect(compiled.exits.stop_pct).toBe(15);
    expect(compiled.exits.trail_pct).toBe(10);
    expect(compiled.exits.pool_drop_pct).toBe(30);
  });

  test("missing top10 gate leaves top10_required false", () => {
    const recipe = {
      ...MIG_EDGE_RECIPE,
      gates: MIG_EDGE_RECIPE.gates.filter((g) => g.field !== "top10"),
    };
    const compiled = compileRecipe(recipe as any);
    expect(compiled.filter.top10_required).toBe(false);
  });

  test("requiredFields list is correct", () => {
    const compiled = compileRecipe(MIG_EDGE_RECIPE as any);
    expect(compiled.requiredFields).toEqual([
      "liq_usd",
      "liq_usd",
      "holders",
      "top10",
      "creator_close",
    ]);
  });
});
