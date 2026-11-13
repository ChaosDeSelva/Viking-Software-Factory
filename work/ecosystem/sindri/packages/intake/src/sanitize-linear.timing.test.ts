import { growthRatio } from "@sindri/testing";
import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";

// Audit M5: the old regex loop was super-linear (200 KB of "<script a" took ~1.8 s).
//
// Linear time is asserted as growth, not as a wall-clock limit (a limit fails on a busy machine):
// the same shape is sanitized at two sizes SCALE apart (see growthRatio). Linear work grows about
// SCALE (16) times, quadratic about SCALE squared (256). GROWTH_LIMIT = 80 leaves 5x headroom over
// linear for noise and still fails anything quadratic by 3x. A *.timing.test.ts file: it runs alone
// after the other suites (pnpm test:timing), so other tests do not skew the measurement.
const SMALL = MAX_DISPLAY_CHARS / 16;
const SCALE = 16;
const GROWTH_LIMIT = SCALE * 5;

/** `make(chars)` builds the hostile shape at about `chars` characters (below the display cap). */
const expectLinear = (make: (chars: number) => string) => {
  const small = make(SMALL);
  const large = make(SMALL * SCALE);
  expect(large.length).toBeLessThanOrEqual(MAX_DISPLAY_CHARS);
  expect(large.length).toBeGreaterThan(small.length * (SCALE - 1));
  const ratio = growthRatio(
    () => sanitizeForDisplay(small),
    () => sanitizeForDisplay(large),
    { scale: SCALE },
  );
  expect(ratio).toBeLessThan(GROWTH_LIMIT);
};

describe("sanitizeForDisplay is linear-time", () => {
  it.each([
    "<script a",
    "<a",
    "<!--",
    "<scr<script>",
    "<style>",
    "</script>",
    "< b >",
    "data:",
    "javascript ",
    "<<",
    "<a <",
  ])("work grows linearly with the number of %j", (unit) => {
    expectLinear((chars) => unit.repeat(Math.floor(chars / unit.length)));
  });

  it.each<[string, (chars: number) => string]>([
    ["< then many >", (n) => "< " + ">".repeat(n - 2)],
    ["many stray < then many >", (n) => "< ".repeat(n / 4) + ">".repeat(n / 2)],
    ["many open tags behind stray < then many >", (n) => "<a <".repeat(n / 8) + ">".repeat(n / 2)],
    [
      "open styles then stray closers",
      (n) => "<style>".repeat(n / 16) + "</script>".repeat(n / 16),
    ],
    ["deeply split tags", (n) => "<sc<b></b>".repeat(n / 10)],
    ["a stray < before every block", (n) => "<<script> > ".repeat(n / 12)],
  ])("work grows linearly for %s", (_name, make) => {
    expectLinear((chars) => make(chars));
  });
});
