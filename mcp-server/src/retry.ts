/**
 * Retry policy engine for TaskFlow.
 * Provides exponential backoff with jitter for network/external calls.
 */

import { logActivity } from './helpers.js';

export interface RetryPolicy {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  initialBackoffMs: 200,
  maxBackoffMs: 2000,
};

/** HTTP status codes considered transient and safe to retry */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/** Classify whether an error is worth retrying */
function isRetryable(err: unknown): boolean {
  if (err instanceof RetriesExhaustedError) return false;
  if (err instanceof TypeError) return true; // network failure, DNS, ECONNREFUSED
  if (err instanceof RetryableHttpError) return true;
  return false;
}

/** Thrown when an HTTP response has a retryable status code */
export class RetryableHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RetryableHttpError';
  }
}

/** Thrown when all retry attempts are exhausted */
export class RetriesExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    const cause = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Retries exhausted after ${attempts} attempt(s): ${cause}`);
    this.name = 'RetriesExhaustedError';
  }
}

/**
 * Compute the next backoff delay with full jitter.
 * delay = min(initial * 2^attempt, max) * random(0.5, 1.0)
 */
function backoffMs(policy: RetryPolicy, attempt: number): number {
  const base = Math.min(policy.initialBackoffMs * Math.pow(2, attempt), policy.maxBackoffMs);
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retry on transient errors.
 *
 * @param label  Short description for activity log entries (e.g. "relay push")
 * @param fn     Async function to execute. Should throw RetryableHttpError for bad HTTP responses.
 * @param policy Retry configuration (defaults to DEFAULT_RETRY_POLICY)
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === policy.maxRetries) {
        break;
      }

      const delay = backoffMs(policy, attempt);
      logActivity('debug_log', `[retry] ${label} — attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
        entityType: 'system',
      });

      await sleep(delay);
    }
  }

  throw new RetriesExhaustedError(policy.maxRetries + 1, lastError);
}

/**
 * Wrapper around fetch() that throws RetryableHttpError for transient HTTP failures.
 * Drop-in for fetch() calls that should participate in retry logic.
 */
export async function fetchWithRetry(
  label: string,
  url: string,
  options?: RequestInit,
  policy?: RetryPolicy,
): Promise<Response> {
  return withRetry(
    label,
    async () => {
      const res = await fetch(url, options);
      if (RETRYABLE_STATUS_CODES.has(res.status)) {
        throw new RetryableHttpError(res.status, `${label}: HTTP ${res.status}`);
      }
      return res;
    },
    policy,
  );
}
