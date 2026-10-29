export interface IngredientSource {
  name: string;
  desc: string;
}

export interface IngredientGateField {
  field: string;
  desc: string;
  example: object;
}

export interface IngredientExitKey {
  key: string;
  desc: string;
  example: number;
}

export interface Ingredients {
  sources: IngredientSource[];
  gate_fields: IngredientGateField[];
  operators: string[];
  exit_keys: IngredientExitKey[];
  rule_triggers: string[];
  rule_actions: string[];
}

export const INGREDIENTS: Ingredients = {
  sources: [
    { name: "mig_edge", desc: "Meme-in-Genesis edge case tokens" },
    { name: "ds_profile", desc: "DexScreener token profiles" },
    { name: "ds_boost", desc: "DexScreener boosted tokens" },
    { name: "custom", desc: "Custom source" },
  ],
  gate_fields: [
    { field: "liq_usd", desc: "Pool liquidity in USD", example: { field: "liq_usd", op: "gte", value: 10000 } },
    { field: "holders", desc: "Number of holders", example: { field: "holders", op: "gte", value: 500 } },
    { field: "top10", desc: "Top 10 holders present", example: { field: "top10", op: "present" } },
    { field: "creator_close", desc: "Creator wallet info present", example: { field: "creator_close", op: "present" } },
    { field: "nuke_ratio", desc: "Max supply in single wallet", example: { field: "nuke_ratio", op: "lte", value: 0.2 } },
    { field: "pool_age_sec", desc: "Seconds since pool creation", example: { field: "pool_age_sec", op: "lte", value: 3600 } },
    { field: "vol_1h", desc: "1-hour volume", example: { field: "vol_1h", op: "gte", value: 100000 } },
  ],
  operators: ["gte", "lte", "eq", "present", "absent"],
  exit_keys: [
    { key: "tp_pct", desc: "Take-profit percentage", example: 30 },
    { key: "stop_pct", desc: "Stop-loss percentage", example: 15 },
    { key: "trail_pct", desc: "Trailing stop percentage", example: 10 },
    { key: "clock_sec", desc: "Max holding time (seconds)", example: 7200 },
    { key: "stall_sec", desc: "Exit if no new high for N seconds", example: 45 },
    { key: "pool_drop_pct", desc: "Exit on pool liquidity drop (%)", example: 50 },
  ],
  rule_triggers: ["timer", "pnl", "wallet_size"],
  rule_actions: ["set_aside", "transfer", "resize", "pause"],
};