import { logger } from "../services/LoggerService.ts";

/**
 * Circuit breaker pattern for external API calls.
 * Tracks failures and opens the circuit after threshold is reached.
 */
export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;

  constructor(failureThreshold: number = 5, resetTimeout: number = 30000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      if (this.state === "half-open") {
        this.state = "closed";
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = "open";
        logger.warn("CIRCUIT_BREAKER", "CircuitBreaker", `Opened after ${this.failureCount} failures`);
      }

      throw error;
    }
  }

  getState(): "closed" | "open" | "half-open" {
    return this.state;
  }
}

/**
 * Exponential backoff with jitter for rate limiting.
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        logger.info("CIRCUIT_BREAKER", "fetchWithRetry", `Rate limited, retrying after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (response.status >= 500 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        logger.info("CIRCUIT_BREAKER", "fetchWithRetry", `Server error ${response.status}, retrying after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        logger.info("CIRCUIT_BREAKER", "fetchWithRetry", `Network error, retrying after ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}