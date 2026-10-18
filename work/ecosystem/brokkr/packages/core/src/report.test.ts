import { describe, expect, it } from "vitest";
import {
  ApprovedExceptionSchema,
  CheckDefinitionSchema,
  ExceptionsFileSchema,
  PolicyLayerSchema,
  ProjectConfigSchema,
  TaskDescriptorSchema,
  VerificationReportSchema,
  validateWith,
} from "./index.js";

export function sampleReport(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    id: "run_01J0000000000000000000000",
    taskId: "UI-142",
    harness: { name: "frontend-react", version: "1.0.0", lockDigest: `sha256:${"a".repeat(64)}` },
    harnesses: [{ name: "frontend-react", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` }],
    repository: { commitSha: "abc123", dirtyTreeDigest: `sha256:${"c".repeat(64)}` },
    startedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:01.000Z",
    verdict: "passed",
    reasons: [],
    checks: [
      {
        id: "typecheck",
        required: true,
        state: "passed",
        command: ["pnpm", "exec", "tsc", "--noEmit"],
        cwd: ".",
        from: ["frontend-react@1.0.0"],
        exitCode: 0,
        durationMs: 1200,
        log: "logs/typecheck.log",
      },
    ],
    policyDecisions: [
      {
        policy: "destructive-commands",
        stage: "before",
        outcome: "allow",
        layer: "system",
        message: "no destructive command",
      },
    ],
    exceptions: [],
    evidence: [
      {
        path: "logs/typecheck.log",
        sha256: `sha256:${"d".repeat(64)}`,
        bytes: 10,
        producedBy: "typecheck",
        kind: "log",
      },
    ],
    summary: { passed: 1, failed: 0, skipped: 0, errored: 0 },
    environment: { brokkrVersion: "0.1.0", node: "v25.0.0", platform: "darwin", arch: "arm64" },
    warnings: [],
  };
}

describe("VerificationReportSchema (spec §10.2)", () => {
  it("accepts a complete report", () => {
    const result = validateWith(VerificationReportSchema, sampleReport());
    expect(result.ok).toBe(true);
  });

  it("requires schemaVersion 1.0, a known verdict and repository.commitSha", () => {
    const bad = sampleReport();
    bad.schemaVersion = "2.0";
    bad.verdict = "mostly-passed";
    bad.repository = {};
    const result = validateWith(VerificationReportSchema, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining(["schemaVersion", "verdict", "repository.commitSha"]),
      );
    }
  });

  it("rejects evidence paths that escape the run directory", () => {
    const bad = sampleReport();
    (bad.evidence as Array<Record<string, unknown>>)[0]!.path = "../../etc/passwd";
    expect(validateWith(VerificationReportSchema, bad).ok).toBe(false);
  });

  it("summary has exactly the four spec counters", () => {
    const bad = sampleReport();
    bad.summary = { passed: 1, failed: 0, skipped: 0, errored: 0, extra: 1 };
    expect(validateWith(VerificationReportSchema, bad).ok).toBe(false);
  });
});

describe("ApprovedExceptionSchema (spec §9.3)", () => {
  const exception = {
    id: "exception-001",
    policy: "check:visual",
    scope: { project: "ravensight", task: "UI-142" },
    reason: "baseline unavailable",
    approvedBy: "project-owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: ["manual-review-142"],
  };

  it("accepts the spec example", () => {
    expect(validateWith(ApprovedExceptionSchema, exception).ok).toBe(true);
    expect(validateWith(ExceptionsFileSchema, { exceptions: [exception] }).ok).toBe(true);
  });

  it("requires approver, reason, scope and expiry", () => {
    for (const key of ["approvedBy", "reason", "scope", "expiresAt", "approvedAt"]) {
      const copy: Record<string, unknown> = { ...exception };
      delete copy[key];
      expect(validateWith(ApprovedExceptionSchema, copy).ok, key).toBe(false);
    }
  });

  it("rejects an expiry before approval", () => {
    const result = validateWith(ApprovedExceptionSchema, {
      ...exception,
      expiresAt: "2026-10-13T00:00:00Z",
    });
    expect(result.ok).toBe(false);
  });
});

describe("policy configuration", () => {
  it("PolicyLayerSchema accepts every category and rejects unknown keys", () => {
    expect(
      validateWith(PolicyLayerSchema, {
        network: "deny",
        destructiveCommands: "deny",
        allowedCommands: ["pnpm", "node"],
        requireApprovalFor: ["install-dependencies"],
        requiredCheckIds: ["typecheck"],
        reviewRequired: false,
        waivable: ["check:visual"],
        nonWaivable: ["check:typecheck"],
      }).ok,
    ).toBe(true);
    expect(validateWith(PolicyLayerSchema, { network: "maybe" }).ok).toBe(false);
    expect(validateWith(PolicyLayerSchema, { secretsAllowed: true }).ok).toBe(false);
  });

  it("project config accepts optional project id and policies", () => {
    expect(
      validateWith(ProjectConfigSchema, {
        version: 1,
        project: "ravensight",
        harnesses: [],
        policies: { requiredCheckIds: ["tests"] },
      }).ok,
    ).toBe(true);
  });

  it("task descriptors may carry per-task policy overrides", () => {
    expect(
      validateWith(TaskDescriptorSchema, {
        id: "UI-1",
        title: "t",
        description: "",
        policies: { network: "deny" },
      }).ok,
    ).toBe(true);
  });

  it("check definitions accept env passthrough keys, waivable and parallel", () => {
    const check = {
      id: "e2e",
      command: ["pnpm", "test"],
      required: true,
      timeoutSeconds: 10,
      env: ["DISPLAY"],
      waivable: true,
      parallel: true,
    };
    expect(validateWith(CheckDefinitionSchema, check).ok).toBe(true);
    expect(validateWith(CheckDefinitionSchema, { ...check, env: ["not valid"] }).ok).toBe(false);
  });
});

describe("summarizeChecks", () => {
  it("counts timed_out and cancelled as errored", async () => {
    const { summarizeChecks } = await import("./index.js");
    const base = { required: true, command: ["x"], cwd: ".", from: [], durationMs: 0 };
    const states = ["passed", "failed", "skipped", "errored", "timed_out", "cancelled"] as const;
    expect(summarizeChecks(states.map((state, i) => ({ ...base, id: `c${i}`, state })))).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      errored: 3,
    });
  });
});

describe("runner-facing schema additions", () => {
  it("when.anyFileExists is an any-of list of safe relative paths", () => {
    const base = {
      id: "e2e",
      command: ["pnpm", "exec", "playwright"],
      required: true,
      timeoutSeconds: 1,
    };
    expect(
      validateWith(CheckDefinitionSchema, {
        ...base,
        when: { anyFileExists: ["playwright.config.ts", "playwright.config.js"] },
      }).ok,
    ).toBe(true);
    expect(
      validateWith(CheckDefinitionSchema, { ...base, when: { anyFileExists: ["../x"] } }).ok,
    ).toBe(false);
  });

  it("check reasons include network_denied and invalid_command", async () => {
    const { CHECK_REASONS } = await import("./index.js");
    expect(CHECK_REASONS).toEqual(expect.arrayContaining(["network_denied", "invalid_command"]));
  });
});

describe("relative paths reject URL schemes (audit I3)", () => {
  it("javascript:, data: and http: paths are not relative paths", async () => {
    const { isSafeRelativePath } = await import("./index.js");
    for (const p of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://x",
      "vbscript:x",
      "JavaScript:x",
    ])
      expect(isSafeRelativePath(p), p).toBe(false);
    expect(isSafeRelativePath("logs/a:b.log")).toBe(true);
  });
});
