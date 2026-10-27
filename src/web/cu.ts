import { Hono } from "hono";

// Static CU cost table for common Helius methods (estimates)
const CU_COSTS: Record<string, number> = {
  "getTokenLargestAccounts": 10,
  "getSignaturesForAddress": 40,
  "getTransaction": 10,
  "getAccountInfo": 5,
  "getBalance": 3,
  "getLatestBlockhash": 5,
  "getSlot": 2,
  "getBlocks": 50,
  "getTransactionCount": 3,
  "getRecentPrioritizationFees": 10,
  "getEpochInfo": 2,
  "getLargestAccounts": 15,
  "getMultipleAccounts": 10,
  "getProgramAccounts": 30,
  "getConfirmedSignaturesForAddress2": 40,
  "getConfirmedTransaction": 10,
  "getLogs": 20,
  "simulateTransaction": 20,
  "sendTransaction": 10,
  "requestAirdrop": 5,
};

// Defaults for unknown methods
const DEFAULT_CU_COST = 5;

export const cuRouter = new Hono();

cuRouter.post("/estimate", async (c) => {
  const body = await c.req.json();
  if (!body.calls || !Array.isArray(body.calls)) {
    return c.json({ ok: false, error: "missing or invalid 'calls' array" }, 400);
  }

  let totalCuPerMin = 0;
  for (const call of body.calls) {
    const method = call.method;
    const perMinute = call.per_minute || 0;
    const cost = CU_COSTS[method] || DEFAULT_CU_COST;
    totalCuPerMin += cost * perMinute;
  }

  const cuPerWeek = totalCuPerMin * 60 * 24 * 7;
  const cuPerMonth = totalCuPerMin * 60 * 24 * 30;

  return c.json({
    ok: true,
    cu_per_min: totalCuPerMin,
    cu_per_week: cuPerWeek,
    cu_per_month: cuPerMonth,
  });
});
