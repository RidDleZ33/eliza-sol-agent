import { describe, test, expect } from "@stdlib/testing";
import { RecipeSchema } from "../recipes/schema.ts";
import { compileRecipe } from "../recipes/compile.ts";

describe("AI tool surface - validate_recipe", () => {
  test("validates a good recipe", () => {
    const recipe = {
      version: 1,
      name: "test",
      sources: ["mig_edge"],
      gates: [
        { field: "holders", op: "gte", value: 500 },
        { field: "liq_usd", op: "gte", value: 100000 }
      ],
      exits: { tp_pct: 30, stop_pct: 15 }
    };
    const result = RecipeSchema.safeParse(recipe);
    expect(result.success).toBe(true);
    const compiled = compileRecipe(result.data);
    expect(compiled.filter.holders_min).toBe(500);
    expect(compiled.filter.liq_min_usd).toBe(100000);
    expect(compiled.exits.tp_pct).toBe(30);
  });

  test("rejects recipe with missing version", () => {
    const recipe = {
      name: "test",
      sources: ["mig_edge"],
      gates: [],
      exits: {}
    };
    const result = RecipeSchema.safeParse(recipe);
    expect(result.success).toBe(false);
  });

  test("rejects invalid source", () => {
    const recipe = {
      version: 1,
      name: "test",
      sources: ["invalid_source"],
      gates: [],
      exits: {}
    };
    const result = RecipeSchema.safeParse(recipe);
    expect(result.success).toBe(false);
  });

  test("rejects invalid operator", () => {
    const recipe = {
      version: 1,
      name: "test",
      sources: ["mig_edge"],
      gates: [{ field: "holders", op: "invalid_op", value: 500 }],
      exits: {}
    };
    const result = RecipeSchema.safeParse(recipe);
    expect(result.success).toBe(false);
  });
});

// Example AI conversation flow:
// User: "add a holders >= 500 gate and a 30% TP"
// -> Model calls suggest_mutation with instruction
// -> suggest_mutation generates recipe JSON via LLM
// -> Generated recipe is validated via RecipeSchema
// -> If valid, recipe is returned and displayed in editor
// User: "validate this recipe"
// -> Model calls validate_recipe with current recipe JSON
// -> Returns ok=true or errors array with validation details
