export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
}

/** Reconnect backoff: 250 ms doubling to 10 s. */
export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 250, maxMs: 10_000 };

/**
 * Delay before reconnect attempt `attempt` (0-based): the exponential step
 * `min(maxMs, initialMs * 2^attempt)` with "equal jitter", i.e. uniformly in `[step/2, step)`.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exp = Math.min(Math.max(attempt, 0), 30);
  const step = Math.min(options.maxMs, options.initialMs * 2 ** exp);
  return step / 2 + (step / 2) * random();
}
