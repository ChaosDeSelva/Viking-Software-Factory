import { growthRatio } from "@sindri/testing";
import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets } from "./secrets.js";

// Secret detection and redaction must stay linear on adversarial input (a backtracking pattern
// would hang bootstrap or prompt building). Asserted as growth, not as a wall-clock limit (which
// failed on busy CI runners): each shape runs at two sizes SCALE apart (see growthRatio); the
// larger is the size the former 500 ms limit used. Linear work grows about SCALE (16) times,
// quadratic about SCALE squared (256). GROWTH_LIMIT = 80 leaves 5x headroom over linear for noise
// and still fails anything quadratic by 3x. A *.timing.test.ts file: it runs alone after the
// other suites (pnpm test:timing), so other tests do not skew the measurement.
const SCALE = 16;
const GROWTH_LIMIT = SCALE * 5;

const expectLinear = (
  run: (text: string) => unknown,
  make: (units: number) => string,
  units: number,
) => {
  const small = make(units / SCALE);
  const large = make(units);
  const ratio = growthRatio(
    () => run(small),
    () => run(large),
    { scale: SCALE },
  );
  expect(ratio).toBeLessThan(GROWTH_LIMIT);
};

describe("secret detection and redaction are linear-time", () => {
  it.each<[string, (k: number) => string, number]>([
    ["many key prefixes then a long value", (k) => "token=".repeat(k) + "a".repeat(2 * k), 50_000],
    ["an unterminated PEM header", (k) => "-----BEGIN " + "A ".repeat(k), 100_000],
  ])("containsSecret grows linearly on %s", (_name, make, units) => {
    expectLinear(containsSecret, make, units);
  });

  it("redactSecrets grows linearly on many key prefixes", () => {
    expectLinear(redactSecrets, (k) => "password=".repeat(k) + "sk-ant-".repeat(k), 20_000);
  });
});
