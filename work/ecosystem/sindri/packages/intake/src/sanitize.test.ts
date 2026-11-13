import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_CHARS, sanitizeForDisplay } from "./sanitize.js";

describe("sanitizeForDisplay", () => {
  it("removes script and style blocks including their content", () => {
    expect(sanitizeForDisplay("a<script>alert(1)</script>b<style>x{}</style>c")).toBe("abc");
    expect(sanitizeForDisplay("<SCRIPT type='x'>evil()</SCRIPT >ok")).toBe("ok");
  });

  it("strips tags, comments and event-handler markup but keeps text", () => {
    expect(sanitizeForDisplay('<p onclick="x()">Hello <b>world</b></p><!-- hidden -->')).toBe(
      "Hello world",
    );
    expect(sanitizeForDisplay('<img src=x onerror="alert(1)">caption')).toBe("caption");
  });

  it("defeats nested/obfuscated tag reassembly", () => {
    const out = sanitizeForDisplay("<scr<script>x</script>ipt>alert(1)</script>");
    expect(out).not.toMatch(/<\s*script/i);
    expect(out).not.toContain("alert(1)");
  });

  it("removes unterminated tags and control characters but keeps plain comparisons", () => {
    expect(sanitizeForDisplay("x <iframe src=evil")).toBe("x ");
    expect(sanitizeForDisplay("a\u0000b\u0007c\nd\te")).toBe("abc\nd\te");
    expect(sanitizeForDisplay("if a < b && b > c")).toBe("if a < b && b > c");
  });

  it("neutralises javascript: and data: URLs left in text", () => {
    expect(sanitizeForDisplay("click javascript:alert(1)")).not.toMatch(/javascript:/i);
    expect(sanitizeForDisplay("see data:text/html;base64,AAAA")).not.toMatch(/data:text\/html/i);
  });
});

// Moved from sanitize-linear.timing.test.ts so they run (and count for coverage) in the normal suite.
describe("sanitizeForDisplay bounds and reassembly", () => {
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
