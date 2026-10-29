import { z } from "zod";

export const RecipeSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  sources: z.array(z.enum(["mig_edge", "ds_profile", "ds_boost", "custom"])),
  gates: z.array(
    z.object({
      field: z.string(),
      op: z.enum(["gte", "lte", "eq", "present", "absent"]),
      value: z.union([z.number(), z.string(), z.boolean()]).optional(),
    })
  ),
  exits: z.object({
    tp_pct: z.number().optional(),
    stop_pct: z.number().optional(),
    trail_pct: z.number().optional(),
    clock_sec: z.number().optional(),
    stall_sec: z.number().optional(),
    pool_drop_pct: z.number().optional(),
  }),
  rules: z.array(
    z.object({
      trigger: z.enum(["timer", "pnl", "wallet_size"]),
      every_sec: z.number().optional(),
      threshold: z.number().optional(),
      action: z.enum(["set_aside", "transfer", "resize", "pause"]),
      params: z.record(z.any()).optional(),
    })
  ).optional(),
  entry_delay_sec: z.number().optional(),
  size_sol: z.number().optional(),
  meta: z.record(z.any()).optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;
