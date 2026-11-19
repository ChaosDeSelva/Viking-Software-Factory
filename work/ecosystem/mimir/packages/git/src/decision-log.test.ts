import { expect, it } from "vitest";
import { appendDecisions } from "./decision-log.js";

const decision = {
  id: "one:accepted",
  markdown: "- Use a default greeting. Why: a missing name is valid.",
};
it("appends inside the existing section, preserving examples, hand edits and following sections", () => {
  const original = [
    "# Requirements",
    "",
    "```md",
    "## Decision log",
    "```",
    "",
    "## Decision log",
    "",
    "- Keep spaces.",
    "",
    "## API",
    "Keep  ",
    "",
  ].join("\r\n");
  const updated = appendDecisions(original, [decision, decision]);
  expect(updated).toContain("- Keep spaces.\r\n\r\n<!-- decision:");
  expect(updated).toContain(decision.markdown + "\r\n\r\n## API\r\nKeep  \r\n");
  expect(appendDecisions(updated.replace("Use a default", "Use our default"), [decision])).toEqual(
    updated.replace("Use a default", "Use our default"),
  );
});
it("handles a first decision, an existing Setext section and an independently dated reversal", () => {
  const base = "Design\n======\n\nDecision log\n------------\n\nOther work\n----------\n";
  const updated = appendDecisions(base, [decision]);
  expect(updated.indexOf(decision.markdown)).toBeLessThan(updated.indexOf("Other work"));
  const reversal = { id: "one:superseded", markdown: "- Replace the default greeting on request." };
  const both = appendDecisions(updated, [decision, reversal]);
  expect(both.match(/<!-- decision:/g)).toHaveLength(2);
  expect(appendDecisions(both, [decision, reversal])).toBe(both);
  expect(appendDecisions("", [decision])).toMatch(/^## Decision log\n/);
  expect(appendDecisions("Project spec", [])).toBe("Project spec");
  const withBom = appendDecisions("\uFEFF## Decision log\n", [decision]);
  expect(withBom.match(/## Decision log/g)).toHaveLength(1);
  expect(withBom.charCodeAt(0)).toBe(0xfeff);
});
