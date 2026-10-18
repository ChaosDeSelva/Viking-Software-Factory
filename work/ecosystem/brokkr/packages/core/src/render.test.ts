import { describe, expect, it } from "vitest";
import {
  bundleDir,
  renderExecutionContract,
  renderTaskBrief,
  type ComposedHarness,
} from "./index.js";

const composed: ComposedHarness = {
  harnesses: [{ name: "frontend-react", version: "1.0.0" }],
  checks: [
    {
      id: "typecheck",
      command: ["pnpm", "exec", "tsc", "--noEmit"],
      required: true,
      timeoutSeconds: 180,
      from: ["frontend-react@1.0.0"],
    },
    {
      id: "lint",
      command: ["pnpm", "run", "lint"],
      required: false,
      timeoutSeconds: 60,
      from: ["frontend-react@1.0.0"],
    },
  ],
  policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: ["modify-ci"] },
  skills: { required: ["typescript"], optional: [] },
  requiredBy: { typescript: ["frontend-react@1.0.0"] },
  workflow: { stages: ["inspect", "implement", "test"] },
  evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: false },
  aiReview: { criteria: [] },
  executionAllowed: true,
  warnings: [],
};

describe("render helpers", () => {
  it("renders the task brief", () => {
    const text = renderTaskBrief({
      id: "UI-1",
      title: "Dash",
      description: "Build it",
      tags: ["react"],
      paths: ["src/a.tsx"],
    });
    expect(text).toContain("# Task UI-1: Dash");
    expect(text).toContain("Build it");
    expect(text).toContain("- Tags: react");
    expect(text).toContain("- Paths: src/a.tsx");
  });

  it("renders the execution contract with argv commands, policies and stages", () => {
    const text = renderExecutionContract(composed);
    expect(text).toContain("frontend-react@1.0.0");
    expect(text).toContain("1. inspect");
    expect(text).toContain("`typecheck` (required): `pnpm exec tsc --noEmit`");
    expect(text).toContain("`lint` (optional)");
    expect(text).toContain("Network access: deny");
    expect(text).toContain("modify-ci");
  });

  it("computes the isolated bundle dir per task and adapter", () => {
    expect(bundleDir("/repo", "UI-1", "claude")).toBe(
      "/repo/.brokkr/generated/task-context/UI-1/claude",
    );
    expect(() => bundleDir("/repo", "../x", "claude")).toThrow();
  });
});
