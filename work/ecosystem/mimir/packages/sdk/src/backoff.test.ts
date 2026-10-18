import { describe, expect, it } from "vitest";
import { backoffDelay, DEFAULT_BACKOFF } from "./backoff.js";

describe("backoffDelay", () => {
  it("defaults to 250 ms doubling up to 10 s", () => {
    expect(DEFAULT_BACKOFF).toEqual({ initialMs: 250, maxMs: 10_000 });
    const top = (n: number) => backoffDelay(n, DEFAULT_BACKOFF, () => 0.999999);
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => Math.round(top(n)))).toEqual([
      250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it("applies jitter between half and the full step", () => {
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0)).toBe(500);
    const mid = backoffDelay(2, DEFAULT_BACKOFF, () => 0.5);
    expect(mid).toBe(750);
  });

  it("does not overflow for large attempt counts", () => {
    expect(backoffDelay(5000, DEFAULT_BACKOFF, () => 0.999)).toBeLessThanOrEqual(10_000);
  });
});
