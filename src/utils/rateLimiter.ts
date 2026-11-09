import type { RateLimitConfig } from '../types/index.js';
import { Logger } from './logger.js';

interface RateLimitError extends Error {
  status?: number;
  response?: {
    status?: number;
    headers?: {
      'retry-after'?: string;
      'Retry-After'?: string;
      'x-ratelimit-limit'?: string;
      'x-ratelimit-remaining'?: string;
      'x-ratelimit-reset'?: string;
      'x-ratelimit-reset-after'?: string;
    };
    data?: {
      retry_after?: number;
      message?: string;
      global?: boolean;
    };
  };
}

export class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;
  private maxRetries: number = 5;
  private baseRetryDelay: number = 500; // Reduced from 1000ms to 500ms for faster retries
  private minSpacing: number; // Minimum ms between task dispatches
  private lastDispatch = 0;

  constructor(config: RateLimitConfig) {
    this.maxConcurrent = Math.max(1, config.maxConcurrentRequests || 1);
    this.minSpacing = Math.max(0, config.delay || 0);
  }

  /**
   * Execute a function with rate limiting and automatic retry on rate limit errors
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await this.executeWithRetry(fn);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  /**
   * Execute a function with automatic rate limit handling and retry logic
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    retryCount: number = 0
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      // Check if this is a rate limit error
      if (this.isRateLimitError(error)) {
        if (retryCount >= this.maxRetries) {
          Logger.error(`Rate limit retry limit exceeded after ${this.maxRetries} attempts`);
          throw new Error('Rate limit retry limit exceeded');
        }

        const MAX_RETRY_WAIT = 60000; // Never wait more than 60s, even if Discord asks for an hour.
        const rawRetryAfter = this.extractRetryAfter(error);
        const retryAfter = Math.min(rawRetryAfter, MAX_RETRY_WAIT);
        const isGlobal = this.isGlobalRateLimit(error);

        if (rawRetryAfter > MAX_RETRY_WAIT) {
          Logger.warning(`⚠️ Discord asked to wait ${Math.round(rawRetryAfter / 1000)}s (likely a global block). Capping to ${MAX_RETRY_WAIT / 1000}s and aborting this request.`);
          // A multi-minute wait means we're hard-limited; fail fast instead of freezing.
          throw new Error('Rate limited for an extended period; skipping this request');
        }

        if (isGlobal) {
          Logger.warning(`⚠️ Global rate limit hit! Waiting ${retryAfter}ms before retry...`);
        } else {
          Logger.warning(`⚠️ Rate limit hit! Waiting ${retryAfter}ms before retry (attempt ${retryCount + 1}/${this.maxRetries})...`);
        }

        // Log rate limit info if available
        this.logRateLimitInfo(error);

        // Wait for the retry-after period
        await this.sleep(retryAfter);

        // Retry with reduced exponential backoff for faster recovery
        const backoffDelay = Math.min(this.baseRetryDelay * Math.pow(1.5, retryCount), 2000); // Max 2s instead of unlimited
        await this.sleep(backoffDelay);

        return this.executeWithRetry(fn, retryCount + 1);
      }

      // Not a rate limit error, rethrow
      throw error;
    }
  }

  /**
   * Check if an error is a rate limit error (429)
   */
  private isRateLimitError(error: any): boolean {
    if (!error) return false;

    const status = error.status || error.response?.status || error.code;
    const message = error.message || error.response?.data?.message || '';

    return (
      status === 429 ||
      message.toLowerCase().includes('rate limit') ||
      message.toLowerCase().includes('too many requests') ||
      message.toLowerCase().includes('ratelimit')
    );
  }

  /**
   * Extract retry-after value from error response
   */
  private extractRetryAfter(error: RateLimitError): number {
    // Try to get from response headers
    const headers = error.response?.headers || {};
    const retryAfterHeader = headers['retry-after'] || headers['Retry-After'];
    
    if (retryAfterHeader) {
      const seconds = parseFloat(retryAfterHeader);
      if (!isNaN(seconds)) {
        return Math.ceil(seconds * 1000); // Convert to milliseconds
      }
    }

    // Try to get from response data
    const retryAfter = error.response?.data?.retry_after;
    if (retryAfter && typeof retryAfter === 'number') {
      return Math.ceil(retryAfter * 1000); // Convert to milliseconds
    }

    // Try to get from x-ratelimit-reset-after header
    const resetAfter = headers['x-ratelimit-reset-after'];
    if (resetAfter) {
      const seconds = parseFloat(resetAfter);
      if (!isNaN(seconds)) {
        return Math.ceil(seconds * 1000);
      }
    }

    // Default fallback: use exponential backoff
    Logger.warning('Could not extract retry-after, using default 5s delay');
    return 5000;
  }

  /**
   * Check if this is a global rate limit
   */
  private isGlobalRateLimit(error: RateLimitError): boolean {
    return error.response?.data?.global === true;
  }

  /**
   * Log rate limit information if available
   */
  private logRateLimitInfo(error: RateLimitError): void {
    const headers = error.response?.headers || {};
    const limit = headers['x-ratelimit-limit'];
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    const resetAfter = headers['x-ratelimit-reset-after'];

    if (limit || remaining || reset || resetAfter) {
      Logger.debug(
        `Rate limit info - Limit: ${limit || 'N/A'}, ` +
        `Remaining: ${remaining || 'N/A'}, ` +
        `Reset: ${reset || 'N/A'}, ` +
        `Reset After: ${resetAfter || 'N/A'}s`
      );
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async processQueue(): Promise<void> {
    // Process tasks up to maxConcurrent, spacing dispatches by minSpacing to avoid bursts
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      if (this.minSpacing > 0) {
        const now = Date.now();
        const wait = this.lastDispatch + this.minSpacing - now;
        if (wait > 0) {
          // Re-check the queue after the spacing window instead of busy-dispatching
          setTimeout(() => this.processQueue(), wait);
          return;
        }
        this.lastDispatch = Date.now();
      }

      const task = this.queue.shift();
      if (!task) break;

      this.running++;

      task().finally(() => {
        this.running--;
        setImmediate(() => this.processQueue());
      });
    }
  }

  async waitForCompletion(): Promise<void> {
    // Ultra-fast polling for completion using setImmediate
    while (this.queue.length > 0 || this.running > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // Use setImmediate for instant polling
    }
  }
}

