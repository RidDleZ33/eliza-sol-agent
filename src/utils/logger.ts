// Centralized logging for the AI Committee trading swarm.
// Supports log levels (DEBUG < INFO < WARN < ERROR < SILENT) with per-category overrides.
// Settings are stored in ConfigService so they can be updated via Telegram Admin Bot.
// Logs always go to console; important events also go to Telegram.



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

const LOG_LEVEL_KEYS = ["LOG_LEVEL", "LOG_LEVEL_INGESTION", "LOG_LEVEL_EXECUTION", "LOG_LEVEL_POSITIONS", "LOG_LEVEL_TELEGRAM", "LOG_LEVEL_WATCHLIST", "LOG_LEVEL_FORENSICS", "LOG_LEVEL_SOCIAL", "LOG_LEVEL_CIRCUIT_BREAKER", "LOG_LEVEL_CONFIG", "LOG_LEVEL_CRASH_RECOVERY", "LOG_LEVEL_DEX"];

function levelMeetsThreshold(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[threshold];
}

function getEffectiveLevel(category: LogCategory): LogLevel {
  // Check category-specific override first
  const categoryKey = `LOG_LEVEL_${category}`;
  try {
    const categoryLevel = configService.getString(categoryKey);
    if (categoryLevel && categoryLevel in LEVEL_PRIORITY) {
      return categoryLevel as LogLevel;
    }
  } catch (e) {
    // Key not registered yet, continue
  }

  // Fall back to global level
  try {
    const globalLevel = configService.getString("LOG_LEVEL");
    if (globalLevel && globalLevel in LEVEL_PRIORITY) {
      return globalLevel as LogLevel;
    }
  } catch (e) {
    // Key not registered yet, use default
  }

  // Default to INFO
  return "INFO";
}

export function setGlobalLogLevel(level: LogLevel) {
  try {
    configService.setString("LOG_LEVEL", level);
  } catch (e) {
    console.log(`[logger] Failed to set global log level: ${e.message}`);
  }
}

export function setCategoryLogLevel(category: LogCategory, level: LogLevel) {
  const key = `LOG_LEVEL_${category}`;
  try {
    configService.setString(key, level);
  } catch (e) {
    console.log(`[logger] Failed to set ${key}: ${e.message}`);
  }
}

export function getGlobalLogLevel(): LogLevel {
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

export function getCategoryLogLevel(category: LogCategory): LogLevel {
  return getEffectiveLevel(category);
}

export function setTelegramEnabled(enabled: boolean) {
  try {
    configService.setString("TELEGRAM_NOTIFICATIONS", enabled ? "true" : "false");
  } catch (e) {
    console.log(`[logger] Failed to set telegram notifications: ${e.message}`);
  }
}

export function isTelegramEnabled(): boolean {
  try {
    const val = configService.getString("TELEGRAM_NOTIFICATIONS");
    return val === "true";
  } catch (e) {
    return true;
  }
}

function formatMessage(level: LogLevel, category: LogCategory, component: string, message: string, extra?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString().slice(0, 19);
  let formatted = `${timestamp} [${level.padEnd(5)}] [${category}] ${component}: ${message}`;
  if (extra) {
    formatted += ` | ${JSON.stringify(extra)}`;
  }
  return formatted;
}

export function log(category: LogCategory, level: LogLevel, component: string, message: string, extra?: Record<string, unknown>) {
  const effectiveLevel = getEffectiveLevel(category);
  if (!levelMeetsThreshold(level, effectiveLevel)) {
    return;
  }

  const formatted = formatMessage(level, category, component, message, extra);

  // Console output
  if (level === "ERROR") {
    console.error(formatted);
  } else if (level === "WARN") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

export function debug(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
  log(category, "DEBUG", component, message, extra);
}

export function info(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
  log(category, "INFO", component, message, extra);
}

export function warn(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
  log(category, "WARN", component, message, extra);
}

export function error(category: LogCategory, component: string, message: string, extra?: Record<string, unknown>) {
  log(category, "ERROR", component, message, extra);
}

/**
 * Send an important event to Telegram regardless of log level settings.
 */
export async function telegramNotify(component: string, message: string) {
  if (!isTelegramEnabled()) {
    return;
  }

  try {
    const { sendTelegramMessage } = await import("./telegram.ts");
    await sendTelegramMessage(`📢 *[${component}]* ${message}`);
  } catch (e) {
    console.log(`[telegramNotify] Failed to send: ${e.message}`);
  }
}

export function getLogSettings() {
  const categories: LogCategory[] = [
    "INGESTION", "EXECUTION", "POSITIONS", "TELEGRAM", "WATCHLIST",
    "FORENSICS", "SOCIAL", "CIRCUIT_BREAKER", "CONFIG", "CRASH_RECOVERY", "DEX",
  ];

  const lines: string[] = [];
  lines.push(`📊 *Log Settings*`);
  lines.push(``);
  lines.push(`*Global Level:* \`${getGlobalLogLevel()}\``);
  lines.push(``);

  for (const cat of categories) {
    const level = getCategoryLogLevel(cat);
    lines.push(`  ${cat}: \`${level}\``);
  }

  lines.push(``);
  lines.push(`📡 *Telegram notifications:* ${isTelegramEnabled() ? "ON" : "OFF"}`);

  return lines.join("\n");
}
