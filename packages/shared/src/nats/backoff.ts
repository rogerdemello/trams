/**
 * Exponential backoff with full jitter, shared by the outbox publisher and the
 * message consumer.
 *
 * Jitter is not decoration. Without it, every worker that failed during the
 * same outage retries at exactly the same moment, and the recovering
 * dependency is hit by a synchronised thundering herd — often knocking it back
 * over, which then re-synchronises the next wave. Full jitter spreads retries
 * across the whole window and breaks that lockstep.
 *
 * Pure and injectable so the schedule is unit-testable: a retry policy that
 * cannot be tested tends to be wrong in the direction nobody notices until an
 * incident.
 */

export interface BackoffOptions {
  /** Delay for the first retry, in milliseconds. */
  baseMs?: number;
  /** Ceiling for any single delay, so backoff cannot grow without bound. */
  maxMs?: number;
  /** Multiplier applied per attempt. */
  factor?: number;
  /** Fraction of the delay randomised, 0..1. 1 = full jitter. */
  jitter?: number;
  /** Injectable randomness for deterministic tests. */
  random?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = {
  baseMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 1,
};

/**
 * Delay before retry number `attempt` (1-based: attempt 1 is the first retry).
 *
 * Returns an integer number of milliseconds, always >= 0 and always <= maxMs.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs, maxMs, factor, jitter } = { ...DEFAULT_BACKOFF, ...options };
  const random = options.random ?? Math.random;

  if (attempt <= 0) return 0;

  // Cap the exponent before computing the power, so a large attempt count
  // cannot produce Infinity and poison the arithmetic below.
  const exponent = Math.min(attempt - 1, 32);
  const uncapped = baseMs * Math.pow(factor, exponent);
  const capped = Math.min(uncapped, maxMs);

  // Full jitter: pick uniformly from [capped * (1 - jitter), capped].
  const jitterRange = capped * Math.min(Math.max(jitter, 0), 1);
  const delay = capped - jitterRange * random();

  return Math.max(0, Math.round(delay));
}

/** Absolute timestamp for the next attempt — what the outbox stores. */
export function nextAttemptAt(attempt: number, from: Date, options: BackoffOptions = {}): Date {
  return new Date(from.getTime() + backoffDelay(attempt, options));
}
