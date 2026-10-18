import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, ComposedHarness, LoadedSkill, ResolvedSkill } from "@brokkr/core";

export function makeContext(overrides: Partial<AdapterContext> = {}): {
  ctx: AdapterContext;
  skills: ResolvedSkill[];
} {
  const cwd = mkdtempSync(join(tmpdir(), "brokkr-adapter-"));
  const store = mkdtempSync(join(tmpdir(), "brokkr-skills-"));
  const catalog: Record<string, LoadedSkill> = {};
  const defs: Array<[string, string, string]> = [
    [
      "react-architecture",
      "Component boundaries and state ownership",
      "# React architecture\n\nKeep state local.\n",
    ],
    [
      "accessibility",
      "WCAG-oriented accessibility rules",
      "# Accessibility\n\nUse semantic elements.\n",
    ],
  ];
  for (const [name, description, body] of defs) {
    const dir = join(store, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "instructions.md"), body);
    catalog[name] = {
      manifest: {
        apiVersion: "brokkr.dev/v1alpha1",
        kind: "Skill",
        metadata: { name, version: "1.0.0", description, tags: [] },
        selectors: {},
        body: "instructions.md",
        estimatedTokens: 100,
      },
      dir,
      bodyPath: join(dir, "instructions.md"),
      digest: `sha256:${"0".repeat(64)}`,
      providedBy: "frontend-react@1.0.0",
    };
  }
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
    ],
    policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: ["modify-ci"] },
    skills: { required: ["react-architecture"], optional: ["accessibility"] },
    requiredBy: { "react-architecture": ["frontend-react@1.0.0"] },
    workflow: { stages: ["inspect", "implement", "test"] },
    evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: false },
    aiReview: { criteria: [] },
    executionAllowed: true,
    warnings: [],
  };
  const ctx: AdapterContext = {
    cwd,
    task: {
      id: "UI-142",
      title: "Build analytics dashboard",
      description: "Create responsive analytics UI",
      tags: ["frontend"],
    },
    composed,
    skillCatalog: catalog,
    ...overrides,
  };
  const skills: ResolvedSkill[] = [
    {
      name: "react-architecture",
      version: "1.0.0",
      selected: true,
      reason: "required by frontend-react@1.0.0",
      requiredBy: "frontend-react@1.0.0",
      score: 0,
    },
    {
      name: "accessibility",
      version: "1.0.0",
      selected: true,
      reason: "keyword 'accessible' in task",
      score: 2,
    },
  ];
  return { ctx, skills };
}
