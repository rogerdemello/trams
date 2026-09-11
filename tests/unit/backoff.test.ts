import { describe, expect, it } from 'vitest';
import { backoffDelay, nextAttemptAt } from '@trams/shared';

/**
 * The retry schedule decides how the system behaves during an outage, so it is
 * worth testing properly. A backoff that grows without bound stalls recovery; a
 * backoff without jitter synchronises every worker into a thundering herd that
 * can re-break the dependency it is waiting on.
 */

describe('backoffDelay', () => {
  it('grows exponentially', () => {
    // Jitter disabled to assert the schedule itself.
    expect(backoffDelay(1, { jitter: 0 })).toBe(1_000);
    expect(backoffDelay(2, { jitter: 0 })).toBe(2_000);
    expect(backoffDelay(3, { jitter: 0 })).toBe(4_000);
    expect(backoffDelay(4, { jitter: 0 })).toBe(8_000);
  });

  it('caps at maxMs so a long outage cannot push retries into next week', () => {
    expect(backoffDelay(20, { jitter: 0 })).toBe(60_000);
    expect(backoffDelay(1_000, { jitter: 0 })).toBe(60_000);
  });

  it('survives an absurd attempt count without overflowing to Infinity', () => {
    // The exponent is clamped before the power is computed. Without that,
    // Math.pow overflows and the arithmetic produces NaN, which would be
    // written into next_attempt_at and permanently strand the row.
    const delay = backoffDelay(Number.MAX_SAFE_INTEGER, { jitter: 0 });

    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(60_000);
  });

  it('returns 0 for attempt 0 or below', () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(-5)).toBe(0);
  });

  it('applies full jitter within the expected band', () => {
    // random() = 0 → no reduction; random() = 1 → maximum reduction.
    expect(backoffDelay(3, { random: () => 0 })).toBe(4_000);
    expect(backoffDelay(3, { random: () => 1 })).toBe(0);
    expect(backoffDelay(3, { random: () => 0.5 })).toBe(2_000);
  });

  it('keeps every jittered sample inside [0, cap]', () => {
    const samples = Array.from({ length: 500 }, () => backoffDelay(4));

    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(8_000);
  });

  it('actually spreads retries out rather than clustering them', () => {
    // The point of jitter. If this produced one distinct value, every worker
    // recovering from the same outage would retry simultaneously.
    const distinct = new Set(Array.from({ length: 200 }, () => backoffDelay(5)));

    expect(distinct.size).toBeGreaterThan(50);
  });

  it('honours a custom factor and base', () => {
    expect(backoffDelay(1, { baseMs: 100, factor: 3, jitter: 0 })).toBe(100);
    expect(backoffDelay(2, { baseMs: 100, factor: 3, jitter: 0 })).toBe(300);
    expect(backoffDelay(3, { baseMs: 100, factor: 3, jitter: 0 })).toBe(900);
  });
});

describe('nextAttemptAt', () => {
  it('offsets from the supplied instant', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const next = nextAttemptAt(1, from, { jitter: 0 });

    expect(next.toISOString()).toBe('2026-01-01T00:00:01.000Z');
  });

  it('never schedules into the past', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(nextAttemptAt(attempt, from).getTime()).toBeGreaterThanOrEqual(from.getTime());
    }
  });
});
