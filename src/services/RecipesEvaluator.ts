import { loadEnabledRecipes, setRecipeStatus } from "../recipes/db.ts";
import { logger } from "./LoggerService.ts";

export interface CandidateFacts {
  mint: string;
  symbol?: string;
  source?: string;
  liq_usd?: number;
  holders?: number;
  top10_rate?: number;
  creator_status?: string;
  nuke_ratio?: number;
  [key: string]: any;
}

export interface RecipeMatch {
  recipeId: string;
  pass: boolean;
  reasons: string[];
}

export class RecipesEvaluator {
  private matching: boolean = false;
  private enabledCount: number = 0;

  constructor() {}

  startMatching() {
    this.matching = true;
    this.enabledCount = this.reloadEnabled().length;
    logger.info("RECIPES", "startMatching", "Recipe evaluation loop enabled", { count: this.enabledCount });
  }

  stopMatching() {
    this.matching = false;
    logger.info("RECIPES", "stopMatching", "Recipe evaluation loop disabled");
  }

  restartMatching() {
    const was = this.matching;
    this.matching = false;
    if (was) {
      this.matching = true;
    }
    this.enabledCount = this.reloadEnabled().length;
    logger.info("RECIPES", "restartMatching", "Recipe evaluation loop restarted", { count: this.enabledCount });
  }

  isMatching() {
    return this.matching;
  }

  getEnabledCount() {
    return this.enabledCount;
  }

  private reloadEnabled(): any[] {
    try {
      return loadEnabledRecipes();
    } catch (e: any) {
      logger.error("RECIPES", "loadEnabledRecipes", "Failed to load enabled recipes", { error: e.message });
      return [];
    }
  }

  evaluateCandidate(facts: CandidateFacts): RecipeMatch[] {
    if (!this.matching) return [];

    const recipes = this.reloadEnabled();
    if (recipes.length === 0) {
      logger.warn("RECIPES", "evaluateCandidate", "No enabled recipes to evaluate", { mint: facts.mint });
      return [];
    }

    const results: RecipeMatch[] = [];

    for (const { id, compiled } of recipes) {
      const pass = this.evaluateOneRecipe(facts, compiled);
      results.push({ recipeId: id, pass, reasons: [] });
    }

    return results;
  }

  private evaluateOneRecipe(facts: CandidateFacts, compiled: any): boolean {
    const filter = compiled.filter;

    if (filter.liq_min_usd !== undefined && (facts.liq_usd === undefined || facts.liq_usd < filter.liq_min_usd)) {
      return false;
    }

    if (filter.liq_max_usd !== undefined && (facts.liq_usd === undefined || facts.liq_usd > filter.liq_max_usd)) {
      return false;
    }

    if (filter.holders_min !== undefined && (facts.holders === undefined || facts.holders < filter.holders_min)) {
      return false;
    }

    if (filter.top10_required && (facts.top10_rate === undefined)) {
      return false;
    }

    if (filter.creator_required && (facts.creator_status === undefined)) {
      return false;
    }

    return true;
  }
}

export const recipesEvaluator = new RecipesEvaluator();