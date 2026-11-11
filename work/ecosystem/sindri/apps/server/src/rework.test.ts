import { describe, expect, it } from "vitest";
import { reworkRequestText } from "./rework.js";

describe("reworkRequestText", () => {
  it("lists each touched file once, at most 60, after the feedback and base commits", () => {
    const files = [...Array.from({ length: 70 }, (_, i) => `src/f${i}.ts`), "src/f0.ts"];
    const text = reworkRequestText({
      originalTitle: "CSV export",
      feedback: "  Use ISO dates.  ",
      baseCommits: ["a".repeat(40), "b".repeat(40)],
      changedFiles: files,
    });
    expect(text).toContain("Rework of a delivered change: CSV export");
    expect(text).toContain("\nUse ISO dates.\n");
    expect(text).toContain(`(commit ${"a".repeat(12)}, ${"b".repeat(12)})`);
    const listed = text.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(60);
    expect(listed[0]).toBe("- src/f0.ts");
    expect(text).not.toContain("- src/f60.ts");
  });

  it("leaves the file list out when nothing is known about the change", () => {
    const text = reworkRequestText({
      originalTitle: "T",
      feedback: "F",
      baseCommits: ["c".repeat(40)],
      changedFiles: [],
    });
    expect(text).not.toContain("Files the delivered change touched");
  });
});
