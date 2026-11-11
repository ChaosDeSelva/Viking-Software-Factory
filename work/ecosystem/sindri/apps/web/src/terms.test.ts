import { getTerm } from "@factory/docs";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every `term="…"` literal in the app's components (tests excluded), with where it is. */
function termLiterals(): { term: string; at: string }[] {
  const out: { term: string; at: string }[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || /\.test\.tsx$/.test(entry.name))
      continue;
    const file = join(entry.parentPath, entry.name);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bterm="([^"]*)"/g))
        out.push({ term: m[1]!, at: `${relative(SRC, file)}:${i + 1}` });
    });
  }
  return out;
}

describe("glossary terms", () => {
  it("every term= literal names a @factory/docs glossary entry", () => {
    const found = termLiterals();
    // The scan itself works: the app uses many InfoHints.
    expect(found.length).toBeGreaterThan(20);
    const missing = found.filter((t) => !getTerm(t.term)).map((t) => `${t.at} "${t.term}"`);
    expect(missing).toEqual([]);
  });
});
