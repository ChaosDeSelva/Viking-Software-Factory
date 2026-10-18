/** Latency/throughput statistics for benchmarks. */
export interface Summary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of an ascending `sorted` array; NaN when empty. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile out of range: ${p}`);
  if (sorted.length === 0) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** Summary statistics of `samples` (not modified). */
export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count,
    min: count === 0 ? NaN : (sorted[0] as number),
    mean: count === 0 ? NaN : sum / count,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: count === 0 ? NaN : (sorted[count - 1] as number),
  };
}
