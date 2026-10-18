import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";

describe("chunkText", () => {
  it("returns a single chunk for short text with 1-based line range", () => {
    expect(chunkText("a\nb\nc\n")).toEqual([
      { ordinal: 0, text: "a\nb\nc", startLine: 1, endLine: 3 },
    ]);
  });

  it("splits at line boundaries near the target size", () => {
    const line = "x".repeat(99); // 100 chars with newline
    const text = Array.from({ length: 20 }, () => line).join("\n");
    const chunks = chunkText(text, 800);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 8],
      [9, 16],
      [17, 20],
    ]);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("keeps an over-long single line as its own chunk", () => {
    const chunks = chunkText(`short\n${"y".repeat(2000)}\nend`, 800);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("returns no chunks for blank text", () => {
    expect(chunkText("  \n\n")).toEqual([]);
  });
});
