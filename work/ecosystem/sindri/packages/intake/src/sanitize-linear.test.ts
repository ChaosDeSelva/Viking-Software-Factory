import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";

// Audit M5: the old regex loop was super-linear (200 KB of "<script a" took ~1.8 s).
const time = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("sanitizeForDisplay is linear-time and bounded", () => {
  it.each([
    ["<script a", 25_000],
    ["<a", 100_000],
    ["<!--", 50_000],
    ["<scr<script>", 20_000],
    ["<style>", 30_000],
    ["</script>", 25_000],
    ["< b >", 40_000],
    ["data:", 40_000],
    ["javascript ", 20_000],
  ])("handles %j x %i quickly", (unit, n) => {
    const input = unit.repeat(n);
    sanitizeForDisplay(input.slice(0, 1000)); // warm up
    expect(time(() => sanitizeForDisplay(input))).toBeLessThan(100);
  });

  it.each([
    ["< then 60k >", "< " + ">".repeat(60_000)],
    ["open styles then stray closers", "<style>".repeat(4_000) + "</script>".repeat(4_000)],
    ["deeply split tags", "<sc<b></b>".repeat(6_000)],
  ])("handles %s quickly", (_name, input) => {
    expect(time(() => sanitizeForDisplay(input))).toBeLessThan(100);
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
