import { configService, ConfigKey } from "./ConfigService.ts";
import { sendTelegramMessage } from "../utils/telegram.ts";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "SILENT";
export type LogCategory =
  | "INGESTION"
  | "EXECUTION"
  | "POSITIONS"
  | "TELEGRAM"
  | "WATCHLIST"
  | "FORENSICS"
  | "SOCIAL"
  | "CIRCUIT_BREAKER"
  | "CONFIG"
  | "CRASH_RECOVERY"
  | "DEX";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4,
};

function levelMeetsThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[threshold];
}

function getEffectiveLevel(category: LogCategory): LogLevel {
  // Check category-specific override first
  const categoryKey = `LOG_LEVEL_${category}`;
  try {
    const categoryLevel = configService.getString(categoryKey as ConfigKey);
    if (categoryLevel && categoryLevel in LEVEL_PRIORITY) {
      return categoryLevel as LogLevel;
    }
  } catch (e) {
    // Key not set, continue
  }

  // Fall back to global level
  try {
    const globalLevel = configService.getString("LOG_LEVEL");
    if (globalLevel && globalLevel in LEVEL_PRIORITY) {
      return globalLevel as LogLevel;
    }
  } catch (e) {
    // Not set, use default
  }

  // Default to INFO
  return "INFO";
}

class LoggerService {
  private telegramEnabled = true;

  setTelegramEnabled(enabled: boolean) {
    this.telegramEnabled = enabled;
  }

  isTelegramEnabled(): boolean {
    return this.telegramEnabled;
  }

  setGlobalLogLevel(level: LogLevel) {
    try {
      configService.setString("LOG_LEVEL", level);
    } catch (e) {
      console.log(`[Logger] Failed to set global log level: ${e.message}`);
    }
    console.log(`[Logger] Global log level set to ${level}`);
  }

  setCategoryLogLevel(category: LogCategory, level: LogLevel) {
    const key = `LOG_LEVEL_${category}`;
    try {
      configService.setString(key as ConfigKey, level);
    } catch (e) {
      console.log(`[Logger] Failed to set ${key}: ${e.message}`);
    }
    console.log(`[Logger] ${category} log level set to ${level}`);
  }

  getGlobalLogLevel(): LogLevel {
    try {
      const level = configService.getString("LOG_LEVEL");
      if (level && level in LEVEL_PRIORITY) {
        return level as LogLevel;
      }
    } catch (e) {
      // Not set
    }
    return "INFO";
  }

  getCategoryLogLevel(category: LogCategory): LogLevel {
    return getEffectiveLevel(category);
  }

  log(
    category: LogCategory,
    level: LogLevel,
    component: string,
    message: string,
    extra?: Record<string, unknown>
  ) {
    const effectiveLevel = getEffectiveLevel(category);
    if (!levelMeetsThreshold(level, effectiveLevel)) {
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 19);
    const formatted = this.formatMessage(timestamp, level, category, component, message, extra);

    // Console output
    if (level === "ERROR") {
      console.error(formatted);
    } else if (level === "WARN") {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  private formatMessage(
    timestamp: string,
    level: LogLevel,
    category: LogCategory,
    component: string,
    message: string,
    extra?: Record<string, unknown>
  ): string {
    let formatted = `${timestamp} [${level.padEnd(5)}] [${category}] ${component}: ${message}`;
    if (extra) {
      formatted += ` | ${JSON.stringify(extra)}`;
    }
    return formatted;
  }

  debug(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
    this.log(category, "DEBUG", component, message, extra);
  }

  info(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
    this.log(category, "INFO", component, message, extra);
  }

  warn(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
    this.log(category, "WARN", component, message, extra);
  }

  error(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
    this.log(category, "ERROR", component, message, extra);
  }

  /**
   * Send an important event to Telegram regardless of log level settings.
   */
  async telegramNotify(component: string, message: string) {
    if (!this.isTelegramEnabled()) {
      return;
    }

    try {
      await sendTelegramMessage(`📢 *[${component}]* ${message}`);
    } catch (e) {
      console.log(`[Logger] Failed to send Telegram notification:`, e);
    }
  }

  /**
   * Get formatted string of current log settings for Telegram display.
   */
  getLogSettings(): string {
    const categories: LogCategory[] = [
      "INGESTION",
      "EXECUTION",
      "POSITIONS",
      "TELEGRAM",
      "WATCHLIST",
      "FORENSICS",
      "SOCIAL",
      "CIRCUIT_BREAKER",
      "CONFIG",
      "CRASH_RECOVERY",
      "DEX",
    ];

    const lines: string[] = [];
    lines.push(`📊 *Log Settings*`);
    lines.push(``);
    lines.push(`*Global Level:* \`${this.getGlobalLogLevel()}\``);
    lines.push(``);

    for (const cat of categories) {
      const level = this.getCategoryLogLevel(cat);
      lines.push(`  ${cat}: \`${level}\``);
    }

    lines.push(``);
    lines.push(`📡 *Telegram notifications:* ${this.isTelegramEnabled() ? "ON" : "OFF"}`);

    return lines.join("\n");
  }
}

export const logger = new LoggerService();
export default logger;