import { describe, expect, it } from "vitest";
import { jaccard, mostSimilar, tokens } from "./similarity.js";

describe("text similarity", () => {
  it("tokenizes words of three or more characters without stop words", () => {
    expect([...tokens("The CSV export should use a comma, and quote fields!")]).toEqual([
      "csv",
      "export",
      "comma",
      "quote",
      "fields",
    ]);
  });

  it("ranks by Jaccard overlap and keeps input order on ties", () => {
    expect(jaccard(tokens("csv export"), tokens("csv export"))).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(0);
    const items = ["pdf import", "csv export delimiter", "unrelated words", "csv import"];
    expect(mostSimilar("which csv delimiter for the export", items, (x) => x, 2)).toEqual([
      { item: "csv export delimiter", score: 1 },
      { item: "csv import", score: 0.25 },
    ]);
  });
});
