// Phase 5A: Entitlement tier module.
// Feature gates based on ENTITLEMENT_TIER env var.
// Default is "operator" (self-run house bot) so nothing changes behavior.
// Future phases add wallet pay-to-upgrade.

export type Tier = "operator" | "desk" | "feed" | "free";
export type Feature = "run_executor" | "run_tape" | "view_trades" | "run_replay";

const TIER = (process.env.ENTITLEMENT_TIER as Tier) || "operator";

// Tier hierarchy: operator > desk > feed > free
// Higher tiers include all lower tier features plus their own.
export const FEATURES: Record<Tier, Set<Feature>> = {
  operator: new Set(["run_executor", "run_tape", "view_trades", "run_replay"]),
  desk:     new Set(["run_tape", "view_trades", "run_replay"]),
  feed:     new Set(["view_trades"]),
  free:     new Set(),
};

export function tier(): Tier {
  return TIER;
}

export function can(feature: Feature): boolean {
  return FEATURES[TIER].has(feature);
}
