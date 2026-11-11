import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";

// Audit M5: the old regex loop was super-linear (200 KB of "<script a" took ~1.8 s).
//
// Linear time is asserted as growth, not as a wall-clock limit (a limit fails on a busy machine):
// the same shape is sanitized at two sizes, and the larger one may cost at most GROWTH_LIMIT times
// the smaller. Linear work costs about SCALE times more, quadratic work about SCALE squared. Each
// size is timed several times and the fastest run counts, since load only ever adds time.
const SMALL = MAX_DISPLAY_CHARS / 16;
const SCALE = 16;
const GROWTH_LIMIT = SCALE * 5; // far below SCALE * SCALE = 256
const fastest = (fn: () => unknown, runs: number) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
/** `make(chars)` builds the hostile shape at about `chars` characters (below the display cap). */
const expectLinear = (make: (chars: number) => string) => {
  const small = make(SMALL);
  const large = make(SMALL * SCALE);
  expect(large.length).toBeLessThanOrEqual(MAX_DISPLAY_CHARS);
  expect(large.length).toBeGreaterThan(small.length * (SCALE - 1));
  sanitizeForDisplay(large); // warm up
  const tSmall = fastest(() => sanitizeForDisplay(small), 25);
  const tLarge = fastest(() => sanitizeForDisplay(large), 25);
  expect(tLarge / Math.max(tSmall, 0.01)).toBeLessThan(GROWTH_LIMIT);
};

describe("sanitizeForDisplay is linear-time and bounded", () => {
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

  it("caps very large input and marks it truncated", () => {
    const out = sanitizeForDisplay("a".repeat(MAX_DISPLAY_CHARS + 10_000));
    expect(out.length).toBeLessThanOrEqual(MAX_DISPLAY_CHARS + 20);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(sanitizeForDisplay("short")).toBe("short");
  });

  it("does not let truncation leave an open tag behind", () => {
    const out = sanitizeForDisplay("x".repeat(MAX_DISPLAY_CHARS - 3) + "<script>alert(1)</script>");
    expect(out).not.toMatch(/<\s*s/i);
  });

  it("keeps reassembly defences: tags split by removed fragments never survive", () => {
    for (const evil of [
      "<scr<script>x</script>ipt>alert(1)</script>",
      "<<script>x</script>script>alert(1)</script>",
      "<scr<!-- c -->ipt>alert(1)</script>",
      "<sc<b></b>ript>alert(1)</sc<i></i>ript>",
      "<!<!-- x -->-- hidden -->",
    ]) {
      const out = sanitizeForDisplay(evil);
      expect(out, evil).not.toMatch(/<\s*\/?\s*[a-z!]/i);
      expect(out, evil).not.toContain("alert(1)");
    }
  });

  it("removes nested and mixed script-like blocks", () => {
    expect(sanitizeForDisplay("a<style>x<script>y</script>z</style>b")).toBe("ab");
    expect(sanitizeForDisplay("a<noscript>n</noscript>b<template>t</template>c")).toBe("abc");
    expect(sanitizeForDisplay("keep <scripts> words")).toBe("keep  words");
    expect(sanitizeForDisplay("a <!-- open comment never closed")).toBe("a ");
    expect(sanitizeForDisplay("a<script>never closed")).toBe("a");
  });
});
