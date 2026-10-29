import type { Recipe } from "./schema.ts";

export interface FilterConfig {
  liq_min_usd?: number;
  liq_max_usd?: number;
  holders_min?: number;
  top10_required: boolean;
  creator_required: boolean;
  // Future: nuke_ratio_max, etc.
}

export interface ExitConfig {
  tp_pct?: number;
  stop_pct?: number;
  trail_pct?: number;
  clock_sec?: number;
  stall_sec?: number;
  pool_drop_pct?: number;
}

export interface CompiledRecipe {
  id: string;
  name: string;
  sources: string[];
  filter: FilterConfig;
  exits: ExitConfig;
  rules: any[];
  requiredFields: string[];
  recipe: Recipe;
}

const DEFAULT_FILTER: FilterConfig = {
  liq_min_usd: undefined,
  liq_max_usd: undefined,
  holders_min: undefined,
  top10_required: false,
  creator_required: false,
};

function applyGate(filter: FilterConfig, gate: any): void {
  const { field, op, value } = gate;

  switch (field) {
    case "liq_usd":
      if (op === "gte") filter.liq_min_usd = value;
      if (op === "lte") filter.liq_max_usd = value;
      break;
    case "holders":
      if (op === "gte") filter.holders_min = value;
      break;
    case "top10":
      if (op === "present") filter.top10_required = true;
      break;
    case "creator_close":
      if (op === "present") filter.creator_required = true;
      break;
    default:
      // Unknown fields for now; future nuke_ratio, etc.
      break;
  }
}

export function compileRecipe(recipe: Recipe): CompiledRecipe {
  const filter = { ...DEFAULT_FILTER };

  for (const gate of recipe.gates) {
    applyGate(filter, gate);
  }

  const exits: ExitConfig = {};
  if (recipe.exits.tp_pct !== undefined) exits.tp_pct = recipe.exits.tp_pct;
  if (recipe.exits.stop_pct !== undefined) exits.stop_pct = recipe.exits.stop_pct;
  if (recipe.exits.trail_pct !== undefined) exits.trail_pct = recipe.exits.trail_pct;
  if (recipe.exits.clock_sec !== undefined) exits.clock_sec = recipe.exits.clock_sec;
  if (recipe.exits.stall_sec !== undefined) exits.stall_sec = recipe.exits.stall_sec;
  if (recipe.exits.pool_drop_pct !== undefined)
    exits.pool_drop_pct = recipe.exits.pool_drop_pct;

  return {
    id: `recipe:${recipe.name}`,
    name: recipe.name,
    sources: recipe.sources,
    filter,
    exits,
    rules: recipe.rules || [],
    requiredFields: recipe.gates.map((g) => g.field),
    recipe,
  };
}
