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
    pool_drop_pct: z.number().optional(),
  }),
  rules: z.array(z.any()).optional(),
  meta: z.record(z.any()).optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;
