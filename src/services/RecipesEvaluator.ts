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
  sizeSol?: number;
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
      const { pass, reasons } = this.evaluateOneRecipe(facts, compiled);
      results.push({
        recipeId: id,
        pass,
        reasons,
        sizeSol: compiled.size_sol,
      });
    }

    return results;
  }

  private evaluateOneRecipe(facts: CandidateFacts, compiled: any): { pass: boolean; reasons: string[] } {
    const filter = compiled.filter;
    const reasons: string[] = [];

    // PHASE 31A: Entry delay enforcement. Recipe decides how long to wait
    // after the source clock before evaluating. Watcher no longer enforces
    // a hardcoded cool-off on the recipe path.
    if (compiled.entry_delay_sec !== undefined && compiled.entry_delay_sec > 0 && facts.source_clock_ms !== undefined) {
      const elapsedMs = Date.now() - facts.source_clock_ms;
      const delayMs = compiled.entry_delay_sec * 1000;
      if (elapsedMs < delayMs) {
        const remainingSec = Math.ceil((delayMs - elapsedMs) / 1000);
        reasons.push(`entry_delay:${remainingSec}s`);
        return { pass: false, reasons };
      }
    }

    if (filter.liq_min_usd !== undefined && (facts.liq_usd === undefined || facts.liq_usd < filter.liq_min_usd)) {
      reasons.push(`liq:${facts.liq_usd}`);
      return { pass: false, reasons };
    }

    if (filter.liq_max_usd !== undefined && (facts.liq_usd === undefined || facts.liq_usd > filter.liq_max_usd)) {
      reasons.push(`liq:${facts.liq_usd}`);
      return { pass: false, reasons };
    }

    if (filter.holders_min !== undefined && (facts.holders === undefined || facts.holders < filter.holders_min)) {
      reasons.push(`holders:${facts.holders}`);
      return { pass: false, reasons };
    }

    if (filter.top10_required && (facts.top10_rate === undefined)) {
      reasons.push("top10");
      return { pass: false, reasons };
    }

    if (filter.creator_required && (facts.creator_status === undefined)) {
      reasons.push("creator");
      return { pass: false, reasons };
    }

    return { pass: true, reasons };
  }
}

export const recipesEvaluator = new RecipesEvaluator();