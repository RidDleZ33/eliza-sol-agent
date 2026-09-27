import { Plugin } from "@elizaos/core";
import { logger } from "../../services/LoggerService.ts";

// Phase 0C: plugin swap tools disabled. Gamma executes via TradeExecutionService,
// not through Eliza actions. No signer or Jupiter calls remain here.
export const tradingExecutionPlugin: Plugin = {
  name: "trading-execution",
  description: "Gamma trading execution plugin (actions disabled in phase 0C)",
  init: async (runtime) => {
    logger.info("EXECUTION", "trading-execution", "plugin initialized (no actions)");
  },
  actions: [],
};
