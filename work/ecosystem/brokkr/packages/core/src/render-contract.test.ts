import { describe, expect, it } from "vitest";
import {
  bundleDir,
  displayCommand,
  renderExecutionContract,
  renderTaskBrief,
  type ComposedHarness,
} from "./index.js";

function composed(over: Partial<ComposedHarness> = {}): ComposedHarness {
  return {
    harnesses: [{ name: "h", version: "1.0.0" }],
    checks: [],
    policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: [] },
    skills: { required: [], optional: [] },
    requiredBy: {},
    workflow: { stages: ["implement"] },
    evidence: { captureLogs: false, captureTestResults: false, captureScreenshots: false },
    aiReview: { criteria: [] },
    executionAllowed: true,
    warnings: [],
    ...over,
  };
}

describe("renderExecutionContract", () => {
  it("describes every when condition, including anyFileExists", () => {
    const text = renderExecutionContract(
      composed({
        checks: [
          {
            id: "e2e",
            command: ["pnpm", "exec", "playwright", "test"],
            required: true,
            timeoutSeconds: 60,
            cwd: "web",
            from: ["h@1.0.0"],
            when: {
              fileExists: ["package.json"],
              anyFileExists: ["playwright.config.ts", "playwright.config.js"],
              scriptExists: ["test"],
            },
          },
        ],
      }),
    );
    expect(text).toContain("when files exist: package.json");
    expect(text).toContain("when any file exists: playwright.config.ts, playwright.config.js");
    expect(text).toContain("when scripts exist: test");
    expect(text).toContain("in `web`");
  });

  it("covers empty harness lists, approvals, untrusted sources, evidence and review", () => {
    const empty = renderExecutionContract(composed({ harnesses: [] }));
    expect(empty).toContain("Harnesses: (none)");
    expect(empty).toContain("(nothing listed)");
    expect(empty).toContain("Brokkr will capture: (nothing)");
    expect(empty).not.toContain("untrusted");

    const full = renderExecutionContract(
      composed({
        policies: {
          network: "allow",
          destructiveCommands: "deny",
          requireApprovalFor: ["modify-ci"],
        },
        executionAllowed: false,
        evidence: { captureLogs: true, captureTestResults: false, captureScreenshots: true },
        aiReview: { criteria: ["Keyboard accessible"] },
        checks: [
          { id: "t", command: ["pnpm", "test"], required: false, timeoutSeconds: 5, from: [] },
        ],
      }),
    );
    expect(full).toContain("Ask for approval before: modify-ci");
    expect(full).toContain("untrusted sources");
    expect(full).toContain("captureLogs, captureScreenshots");
    expect(full).toContain("### Review criteria");
    expect(full).toContain("(optional)");
  });
});

describe("render helpers", () => {
  it("displayCommand quotes arguments with whitespace or shell characters", () => {
    expect(displayCommand(["node", "-e", "console.log(1)", "a b", "$x"])).toBe(
      'node -e console.log(1) "a b" "$x"',
    );
  });

  it("renderTaskBrief includes optional fields only when present", () => {
    expect(renderTaskBrief({ id: "T-1", title: "t", description: "" })).toBe(
      "# Task T-1: t\n\n(no description)\n",
    );
    const full = renderTaskBrief({
      id: "T-2",
      title: "t",
      description: "d",
      tags: ["a"],
      taskTypes: ["ui"],
      paths: ["src"],
      context: { ticket: "UI-1" },
    });
    for (const s of ["- Tags: a", "- Task types: ui", "- Paths: src", "- ticket: UI-1"])
      expect(full).toContain(s);
  });

  it("bundleDir rejects unsafe task ids", () => {
    expect(() => bundleDir("/r", "../x", "claude")).toThrow(/not a safe directory name/);
    expect(bundleDir("/r", "T-1", "claude")).toBe("/r/.brokkr/generated/task-context/T-1/claude");
  });
});
