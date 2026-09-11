import { watchlistService } from "./WatchlistService.ts";
import { EventEmitter } from "events";
import {
  getMaxTrendingTokens,
  getMaxTopTraders,
  getIngestionInterval,
  getMaxTradeSizeSol,
  getSlippageBps,
  getJitoTipLamports,
  getMaxConcurrentPositions,
  getTakeProfitPct,
  getStopLossPct,
  getTrailingStopPct,
  getStalePositionMinutes,
  getPositionCheckIntervalMs,
  getRugcheckApiUrl,
  getMinLiquidityUsd,
  getMaxTop10ConcentrationPct,
  getWalletMirrorInterval,
  isDryRun
} from "../utils/env.ts";

export type ConfigKey =
  | "MAX_TRENDING_TOKENS"
  | "MAX_TOP_TRADERS"
  | "INGESTION_INTERVAL_MS"
  | "MIN_TRADER_PNL_USD"
  | "MIN_NARRATIVE_SCORE"
  | "ALPHA_EVAL_INTERVAL_MS"
  | "RUGCHECK_MAX_SCORE"
  | "MIN_LIQUIDITY_USD"
  | "MAX_TOP10_CONCENTRATION_PCT"
  | "WALLET_MIRROR_INTERVAL_MS"
  | "MAX_TRADE_SIZE_SOL"
  | "SLIPPAGE_BPS"
  | "JITO_TIP_LAMPORTS"
  | "MAX_CONCURRENT_POSITIONS"
  | "DRY_RUN_MODE"
  | "TAKE_PROFIT_PCT"
  | "STOP_LOSS_PCT"
  | "TRAILING_STOP_PCT"
  | "STALE_POSITION_MINUTES"
  | "POSITION_CHECK_INTERVAL_MS";

interface ConfigEntry {
  key: ConfigKey;
  value: string;
  category: string;
  description: string;
  defaultValue: string;
  validate?: (value: string) => boolean;
}

const DEFAULT_CONFIG: ConfigEntry[] = [
  // Ingestion & Watchlist (Modules 1 & 2)
  {
    key: "MAX_TRENDING_TOKENS",
    value: "",
    category: "INGESTION",
    description: "Maximum number of trending tokens to track",
    defaultValue: String(getMaxTrendingTokens()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 50
  },
  {
    key: "MAX_TOP_TRADERS",
    value: "",
    category: "INGESTION",
    description: "Maximum number of top traders to track",
    defaultValue: String(getMaxTopTraders()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 50
  },
  {
    key: "INGESTION_INTERVAL_MS",
    value: "",
    category: "INGESTION",
    description: "How often to check for new trending tokens (ms)",
    defaultValue: String(getIngestionInterval()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 10000
  },
  {
    key: "MIN_TRADER_PNL_USD",
    value: "",
    category: "INGESTION",
    description: "Minimum 7-day PnL for top trader inclusion (USD)",
    defaultValue: "1000",
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 0
  },

  // Alpha Social Evaluator (Module 3)
  {
    key: "MIN_NARRATIVE_SCORE",
    value: "",
    category: "EVALUATOR",
    description: "Minimum narrative score to pass evaluation (0-1)",
    defaultValue: "0.75",
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 0 && parseFloat(v) <= 1
  },
  {
    key: "ALPHA_EVAL_INTERVAL_MS",
    value: "",
    category: "EVALUATOR",
    description: "How often Alpha evaluates narrative signals (ms)",
    defaultValue: "180000",
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 10000
  },

  // Beta Forensics & Wallet Mirroring (Module 4)
  {
    key: "RUGCHECK_MAX_SCORE",
    value: "",
    category: "FORENSICS",
    description: "Maximum RugCheck score to pass evaluation",
    defaultValue: "15",
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 0 && parseInt(v) <= 100
  },
  {
    key: "MIN_LIQUIDITY_USD",
    value: "",
    category: "FORENSICS",
    description: "Minimum required liquidity (USD)",
    defaultValue: String(getMinLiquidityUsd()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0
  },
  {
    key: "MAX_TOP10_CONCENTRATION_PCT",
    value: "",
    category: "FORENSICS",
    description: "Maximum top 10 holder concentration (%)",
    defaultValue: String(getMaxTop10ConcentrationPct()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0 && parseFloat(v) <= 100
  },
  {
    key: "WALLET_MIRROR_INTERVAL_MS",
    value: "",
    category: "FORENSICS",
    description: "How often to mirror top trader wallets (ms)",
    defaultValue: String(getWalletMirrorInterval()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 10000
  },

  // Gamma Execution & Risk Guardrails (Module 5)
  {
    key: "MAX_TRADE_SIZE_SOL",
    value: "",
    category: "RISK",
    description: "Maximum trade size per buy (SOL)",
    defaultValue: String(getMaxTradeSizeSol()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0
  },
  {
    key: "SLIPPAGE_BPS",
    value: "",
    category: "RISK",
    description: "Maximum slippage tolerance (basis points)",
    defaultValue: String(getSlippageBps()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 500
  },
  {
    key: "JITO_TIP_LAMPORTS",
    value: "",
    category: "RISK",
    description: "Jito tip for transaction prioritization (lamports)",
    defaultValue: String(getJitoTipLamports()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) >= 0
  },
  {
    key: "MAX_CONCURRENT_POSITIONS",
    value: "",
    category: "RISK",
    description: "Maximum number of open positions at once",
    defaultValue: String(getMaxConcurrentPositions()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 0 && parseInt(v) <= 20
  },
  {
    key: "DRY_RUN_MODE",
    value: "",
    category: "RISK",
    description: "If true, simulate trades without executing on-chain",
    defaultValue: isDryRun() ? "true" : "false",
    validate: (v) => v === "true" || v === "false"
  },

  // Position Manager & Exits (Module 6)
  {
    key: "TAKE_PROFIT_PCT",
    value: "",
    category: "EXITS",
    description: "Auto-sell when profit reaches this percentage",
    defaultValue: String(getTakeProfitPct()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0
  },
  {
    key: "STOP_LOSS_PCT",
    value: "",
    category: "EXITS",
    description: "Auto-sell when loss reaches this percentage",
    defaultValue: String(getStopLossPct()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) >= 1 && parseFloat(v) <= 90
  },
  {
    key: "TRAILING_STOP_PCT",
    value: "",
    category: "EXITS",
    description: "Trailing stop distance below peak (%)",
    defaultValue: String(getTrailingStopPct()),
    validate: (v) => !isNaN(parseFloat(v)) && parseFloat(v) > 0 && parseFloat(v) <= 50
  },
  {
    key: "STALE_POSITION_MINUTES",
    value: "",
    category: "EXITS",
    description: "Exit stagnant positions after this many minutes",
    defaultValue: String(getStalePositionMinutes()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 5
  },
  {
    key: "POSITION_CHECK_INTERVAL_MS",
    value: "",
    category: "EXITS",
    description: "How often to check position prices for exits (ms)",
    defaultValue: String(getPositionCheckIntervalMs()),
    validate: (v) => !isNaN(parseInt(v)) && parseInt(v) > 1000
  }
];

class ConfigService {
  private cache: Map<ConfigKey, string>;
  private emitter = new EventEmitter();

  constructor() {
    this.cache = new Map();
    this.loadDefaults();
  }

  private loadDefaults() {
    for (const entry of DEFAULT_CONFIG) {
      this.cache.set(entry.key, entry.defaultValue);
    }
  }

  /**
   * Get a configuration value. Returns cached value for microsecond access.
   */
  get(key: ConfigKey): string {
    const value = this.cache.get(key);
    if (value === undefined) {
      throw new Error(`Configuration key not found: ${key}`);
    }
    return value;
  }

  /**
   * Get a numeric configuration value.
   */
  getNumber(key: ConfigKey): number {
    const value = this.get(key);
    const num = parseFloat(value);
    if (isNaN(num)) {
      throw new Error(`Configuration value for ${key} is not a number: ${value}`);
    }
    return num;
  }

  /**
   * Get a boolean configuration value.
   */
  getBoolean(key: ConfigKey): boolean {
    return this.get(key).toLowerCase() === "true";
  }

  /**
   * Set a configuration value. Updates DB, cache, and emits change event.
   */
  async set(key: ConfigKey, value: any): Promise<void> {
    const entry = DEFAULT_CONFIG.find(e => e.key === key);
    if (!entry) {
      throw new Error(`Unknown configuration key: ${key}`);
    }

    const strValue = String(value);

    // Validate if validator exists
    if (entry.validate && !entry.validate(strValue)) {
      throw new Error(`Invalid value for ${key}: ${strValue}. Validator failed.`);
    }

    // Update cache immediately
    this.cache.set(key, strValue);

    // Persist to DB
    try {
      const db = watchlistService.getDb();
      db.prepare(`
        INSERT OR REPLACE INTO config_settings (key, value, category, description, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(key, strValue, entry.category, entry.description);
    } catch (e) {
      console.error(`Failed to persist config ${key}:`, e);
    }

    // Emit change event
    this.emitter.emit("configUpdated", { key, value: strValue });
    console.log(`[ConfigService] Updated ${key} = ${strValue}`);
  }

  /**
   * Toggle a boolean configuration value.
   */
  async toggle(key: ConfigKey): Promise<void> {
    const current = this.getBoolean(key);
    await this.set(key, !current);
  }

  /**
   * Subscribe to configuration changes.
   */
  on(key: "configUpdated", callback: (event: { key: ConfigKey, value: string }) => void) {
    this.emitter.on(key, callback);
  }

  /**
   * Get all configuration entries grouped by category.
   */
  getAll(): Map<string, { key: ConfigKey, value: string, description: string }[]> {
    const grouped = new Map<string, { key: ConfigKey, value: string, description: string }[]>();

    for (const entry of DEFAULT_CONFIG) {
      if (!grouped.has(entry.category)) {
        grouped.set(entry.category, []);
      }
      grouped.get(entry.category)!.push({
        key: entry.key,
        value: this.cache.get(entry.key) || entry.defaultValue,
        description: entry.description
      });
    }

    return grouped;
  }
}

export const configService = new ConfigService();
export default configService;