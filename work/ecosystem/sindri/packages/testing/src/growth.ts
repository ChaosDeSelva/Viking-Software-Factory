/**
 * How many times longer one call of `large` takes than one call of `small`, where `large` works on
 * an input `scale` times the size of `small`'s. A linear-time operation gives about `scale`; a
 * quadratic one about `scale * scale`. For `*.timing.test.ts` files, which run on their own.
 *
 * Built to resist machine load, which only ever adds time:
 * - each size is timed `runs` times and the fastest run counts;
 * - the two sizes are timed alternately, so a burst of load falls on both;
 * - one sample of `small` is `scale` calls, so both samples last about as long and are equally
 *   likely to be preempted (a short sample would slip between preemptions and a long one not).
 */
export function growthRatio(
  small: () => unknown,
  large: () => unknown,
  { scale, runs = 40, now = () => performance.now() }: GrowthOptions,
): number {
  const time = (fn: () => unknown, calls: number) => {
    const t0 = now();
    for (let i = 0; i < calls; i++) fn();
    return now() - t0;
  };
  time(large, 1); // warm up both paths before measuring
  time(small, scale);
  let bestSmall = Infinity;
  let bestLarge = Infinity;
  for (let i = 0; i < runs; i++) {
    bestSmall = Math.min(bestSmall, time(small, scale));
    bestLarge = Math.min(bestLarge, time(large, 1));
  }
  return bestLarge / (Math.max(bestSmall, 0.001) / scale);
}

export interface GrowthOptions {
  /** How many times larger `large`'s input is than `small`'s. */
  scale: number;
  /** Samples per size; the fastest counts. */
  runs?: number;
  /** Clock in milliseconds; tests of this helper pass a fake one. */
  now?: () => number;
}
