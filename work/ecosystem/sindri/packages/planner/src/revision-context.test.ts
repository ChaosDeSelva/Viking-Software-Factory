import { describe, expect, it } from "vitest";
import { revisionContext } from "./planner.js";
import { CONTEXT_TRUNCATED_MARKER, MAX_FOLLOW_UP_CONTEXT_CHARS } from "./schema.js";

describe("revisionContext", () => {
  const factCheck = {
    verdict: "request_changes",
    findings: [{ severity: "major", message: "Week 1 does not fit." }],
  };

  it("puts the fact-check before the document, so a cut keeps the findings", () => {
    const huge = `# Plan\n${"x".repeat(MAX_FOLLOW_UP_CONTEXT_CHARS)}END-OF-DOCUMENT`;
    const text = revisionContext(huge, factCheck);
    expect(
      text.startsWith("## Fact-check of the earlier document (verdict: request_changes)"),
    ).toBe(true);
    expect(text).toContain("- [major] Week 1 does not fit.");
    expect(text.endsWith(CONTEXT_TRUNCATED_MARKER)).toBe(true);
    expect(text).not.toContain("END-OF-DOCUMENT");
  });

  it("keeps a document without a fact-check as it is", () => {
    expect(revisionContext("# Plan\nbody")).toBe("# Plan\nbody");
  });
});
