import { describe, expect, it } from "vitest";
import { sanitizeForDisplay } from "./sanitize.js";

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
