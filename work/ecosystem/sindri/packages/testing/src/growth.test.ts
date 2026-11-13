import { describe, expect, it } from "vitest";
import { growthRatio } from "./growth.js";

// A fake clock: each call advances it by the cost the test assigns, so the ratio is exact.
const clock = () => {
  let t = 0;
  return { now: () => t, spend: (ms: number) => (t += ms) };
};

describe("growthRatio", () => {
  it("reports about scale for linear work and scale squared for quadratic work", () => {
    const c = clock();
    const scale = 16;
    expect(
      growthRatio(
        () => c.spend(1),
        () => c.spend(scale),
        { scale, now: c.now },
      ),
    ).toBe(16);
    expect(
      growthRatio(
        () => c.spend(1),
        () => c.spend(scale * scale),
        { scale, now: c.now },
      ),
    ).toBe(256);
  });

  it("counts the fastest sample, so load on some runs does not inflate the ratio", () => {
    const c = clock();
    let call = 0;
    // Every other large call is slowed tenfold, as if preempted; the fastest still counts.
    const ratio = growthRatio(
      () => c.spend(1),
      () => c.spend(++call % 2 ? 160 : 16),
      { scale: 16, runs: 10, now: c.now },
    );
    expect(ratio).toBe(16);
  });

  it("does not divide by zero when the small input costs nothing measurable", () => {
    const c = clock();
    expect(
      Number.isFinite(
        growthRatio(
          () => 0,
          () => c.spend(1),
          { scale: 4, now: c.now },
        ),
      ),
    ).toBe(true);
  });
});
