/**
 * Edge and failure paths of the Brokkr SDK facade: input validation, caller
 * options that reach the runner, integrity findings in `materialize`, and
 * error mapping in `verify`. Every test uses a temp home.
 */
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brokkr, type BrokkrOptions, type Selection, type VerificationEvent } from "./index.js";
import { MockExecutor, type MockOutcome } from "./testing.js";
import { BUILTIN, TASK, reactRepo, tempDir, writeConfig } from "../test/fixtures.js";

const QA = { id: "QA-3", title: "qa", description: "qa", taskTypes: ["qa"] };

const make = (cwd: string, extra: Partial<BrokkrOptions> = {}) =>
  new Brokkr({ cwd, builtinDir: BUILTIN, homeDir: tempDir("brokkr-home-"), ...extra });

function recordingLogger() {
  const lines: Array<{ obj: object; msg?: string }> = [];
  const log = (obj: object, msg?: string) => lines.push({ obj, ...(msg ? { msg } : {}) });
  return { lines, logger: { debug: log, info: log, warn: log, error: log } };
}

const HARNESS = (name: string, version: string, extra = "") => `apiVersion: brokkr.dev/v1alpha1
kind: Harness
metadata: { name: ${name}, version: ${version}, description: "test harness" }
compatibility: { platforms: [darwin, linux, win32], taskTypes: [qa] }
${extra}skills: { required: [], optional: [] }
workflow: { stages: [verify] }
checks:
  - { id: ${name}-check, command: ["true"], required: true, timeoutSeconds: 10 }
policies: { network: deny, destructiveCommands: deny, requireApprovalFor: [] }
evidence: { captureLogs: true, captureTestResults: false, captureScreenshots: false }
`;

/** A temp home whose ~/.brokkr/harnesses holds the given harness manifests. */
function homeWith(harnesses: Record<string, string>): string {
  const home = tempDir("brokkr-home-");
  for (const [dir, yaml] of Object.entries(harnesses)) {
    const h = join(home, ".brokkr", "harnesses", dir);
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "harness.yaml"), yaml);
  }
  return home;
}

describe("new Brokkr(options)", () => {
  it("requires a repository path", () => {
    for (const bad of [undefined, { cwd: "" }, { cwd: 42 }])
      expect(() => new Brokkr(bad as never)).toThrow(
        expect.objectContaining({ code: "invalid-config", message: expect.stringMatching(/cwd/) }),
      );
  });

  it("defaults to the shipped harness library and the user's home (nothing is read yet)", () => {
    class Probe extends Brokkr {
      dirs() {
        return { builtinDir: this.builtinDir, homeDir: this.homeDir };
      }
    }
    const probe = new Probe({ cwd: tempDir() });
    expect(probe.dirs()).toEqual({ builtinDir: BUILTIN, homeDir: homedir() });
    expect(probe.offline).toBe(false);
    expect(new Probe({ cwd: tempDir(), offline: true }).offline).toBe(true);
  });
});

describe("Brokkr.resolve edge paths", () => {
  it("rejects malformed and empty harness requests", async () => {
    const brokkr = make(reactRepo());
    await expect(
      brokkr.resolve({ task: TASK, harnesses: [{ name: "Not Kebab", version: "^1.0.0" }] }),
    ).rejects.toMatchObject({ code: "invalid-config", message: expect.stringMatching(/name/) });
    await expect(brokkr.resolve({ task: TASK, harnesses: [] })).rejects.toMatchObject({
      code: "invalid-config",
      message: "resolve: harnesses must not be empty",
    });
  });

  it("selects by repository signals when no task type or tag matches", async () => {
    const s = await make(reactRepo()).resolve({ task: { ...TASK, tags: [] } });
    expect(s.harnesses.map((h) => h.name)).toEqual(["frontend-react"]);
    const why = s.rationale.find((r) => r.kind === "harness" && r.name === "frontend-react");
    expect(why?.reason).not.toMatch(/task types\/tags match/);
  });

  it("records harnesses pulled in as dependencies", async () => {
    const homeDir = homeWith({
      "docs-plus": HARNESS(
        "docs-plus",
        "1.0.0",
        "dependsOn: [{ name: documentation, version: ^1.0.0 }]\n",
      ),
    });
    const s = await make(reactRepo(), { homeDir }).resolve({
      task: QA,
      harnesses: [{ name: "docs-plus", version: "^1.0.0" }],
    });
    expect(s.harnesses.map((h) => h.name).sort()).toEqual(["docs-plus", "documentation"]);
    expect(s.rationale).toContainEqual(
      expect.objectContaining({
        kind: "harness",
        name: "documentation",
        selected: true,
        reason: "dependency of docs-plus@1.0.0",
      }),
    );
  });

  it("passes a token budget to skill selection and reports what it dropped", async () => {
    const brokkr = make(reactRepo());
    const full = await brokkr.resolve({ task: TASK, profile: "frontend-strict" });
    const tight = await brokkr.resolve({ task: TASK, profile: "frontend-strict", budgetTokens: 1 });
    expect(tight.skills.length).toBeLessThan(full.skills.length);
    expect(tight.rationale).toContainEqual(
      expect.objectContaining({
        kind: "skill",
        selected: false,
        reason: expect.stringMatching(/context budget of 1 tokens/),
      }),
    );
  });

  it("an unknown or malformed profile name is not-found; the message names the trust mode's sources", async () => {
    const cwd = reactRepo();
    await expect(make(cwd).resolve({ task: TASK, profile: "Bad_Name" })).rejects.toMatchObject({
      code: "not-found",
      message: "profile 'Bad_Name' is not a built-in or caller-supplied profile",
    });
    writeConfig(cwd, "version: 1\nharnesses: []\n");
    await expect(
      make(cwd, { trust: "developer" }).resolve({ task: TASK, profile: "ghost" }),
    ).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringMatching(/not defined in \.brokkr\/config\.yaml/),
    });
  });

  it("a malformed built-in profile file is invalid-config", async () => {
    const builtinDir = join(tempDir("brokkr-builtin-"), "harnesses");
    cpSync(BUILTIN, builtinDir, { recursive: true });
    writeFileSync(join(builtinDir, "profiles", "broken.yaml"), "name: broken\nharnesses: 7\n");
    await expect(
      make(reactRepo(), { builtinDir }).resolve({ task: TASK, profile: "broken" }),
    ).rejects.toMatchObject({ code: "invalid-config", message: /invalid profile/ });
  });

  it("a profile listing the same harness twice resolves and pins one digest regardless of order", async () => {
    const twice = (order: "asc" | "desc") => ({
      name: "twice",
      harnesses:
        order === "asc"
          ? [
              { name: "documentation", version: "^1.0.0" },
              { name: "documentation", version: ">=1.0.0" },
            ]
          : [
              { name: "documentation", version: ">=1.0.0" },
              { name: "documentation", version: "^1.0.0" },
            ],
    });
    const cwd = reactRepo();
    const a = await make(cwd, { profiles: [twice("asc")] }).resolve({ task: QA, profile: "twice" });
    const b = await make(cwd, { profiles: [twice("desc")] }).resolve({
      task: QA,
      profile: "twice",
    });
    expect(a.harnesses.map((h) => h.name)).toEqual(["documentation"]);
    expect(a.lock.profile?.digest).toBe(b.lock.profile?.digest);
  });

  it("developer mode: auto-selection skips untrusted sources and prefers the newest version", async () => {
    const homeDir = homeWith({ "qa-regression": HARNESS("qa-regression", "9.9.9") });
    const cwd = reactRepo();
    const vendor = join(cwd, "vendor", "untrusted-qa");
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, "harness.yaml"), HARNESS("untrusted-qa", "1.0.0"));
    const { treeDigest } = await import("@brokkr/core");
    writeConfig(
      cwd,
      `version: 1\nharnesses: []\nsources:\n  - path: vendor\n    digest: "${await treeDigest(join(cwd, "vendor"))}"\n    trusted: false\n`,
    );
    const brokkr = make(cwd, { trust: "developer", homeDir });
    const s = await brokkr.resolve({ task: QA });
    expect(s.harnesses.map((h) => `${h.name}@${h.version}`)).toEqual(["qa-regression@9.9.9"]);
    expect(s.rationale.map((r) => r.name)).not.toContain("untrusted-qa");
    // listHarnesses shows every version, ordered by name then version.
    const listed = (await brokkr.listHarnesses())
      .filter((h) => h.name === "qa-regression")
      .map((h) => h.version);
    expect(listed).toEqual(["1.0.0", "9.9.9"]);
  });
});

describe("Brokkr.prepare edge paths", () => {
  it("refuses a workspace the adapter cannot use and logs adapter warnings otherwise", async () => {
    const cwd = reactRepo();
    const { lines, logger } = recordingLogger();
    const brokkr = make(cwd, { logger });
    const selection = await brokkr.resolve({ task: TASK, profile: "frontend-strict" });
    await expect(
      brokkr.prepare({
        selection,
        provider: "generic",
        workspace: join(tempDir(), "missing"),
      }),
    ).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/generic cannot prepare this task: .*does not exist/),
    });
    await brokkr.prepare({ selection, provider: "claude-code" });
    expect(lines).toContainEqual({
      obj: { provider: "claude-code" },
      msg: expect.stringMatching(/bundle is isolated/),
    });
  });
});

describe("Brokkr.verify caller options", () => {
  async function planned(
    extra: Partial<BrokkrOptions> = {},
    script: Record<string, MockOutcome> = { test: "passed" },
  ) {
    const cwd = reactRepo();
    const executor = new MockExecutor(script);
    const brokkr = make(cwd, { executor, ...extra });
    const selection = await brokkr.resolve({
      task: QA,
      harnesses: [{ name: "qa-regression", version: "^1.0.0" }],
    });
    return { cwd, brokkr, executor, selection };
  }

  it("records the caller's task, project id and workspace id", async () => {
    const { brokkr, selection } = await planned();
    const report = await brokkr.verify({
      selection,
      workspace: reactRepo(),
      task: { ...QA, id: "QA-OVERRIDE" },
      projectId: "proj-1",
      workspaceId: "ws-9",
    });
    expect(report.taskId).toBe("QA-OVERRIDE");
    expect(report.projectId).toBe("proj-1");
    expect(report.repository.workspaceId).toBe("ws-9");
    await expect(
      brokkr.verify({ selection, workspace: reactRepo(), task: { ...QA, id: "../x" } }),
    ).rejects.toMatchObject({ code: "invalid-config", message: /invalid task/ });
  });

  it("stores the run under the caller's run root, signed with the caller's key", async () => {
    const runRoot = tempDir("brokkr-runroot-");
    const signingKey = Buffer.alloc(32, 7);
    const { brokkr, selection } = await planned({ runRoot, signingKey });
    const report = await brokkr.verify({ selection, workspace: reactRepo() });
    const runDir = join(runRoot, report.id);
    const stored = await brokkr.readReport(runDir);
    expect(stored.integrity.status).toBe("ok");
    expect(stored.report.id).toBe(report.id);
    // The default key of another home cannot vouch for it.
    expect((await make(tempDir()).readReport(runDir)).integrity.status).toBe("integrity_failed");
  });

  it("honours caller exceptions only from listed approvers (workspace-untrusted)", async () => {
    const exception = {
      id: "ex-approved",
      policy: "check:test",
      scope: {},
      reason: "approved upstream",
      approvedBy: "lead@example.com",
      approvedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      evidence: [],
    };
    const ignored = /exception ex-approved ignored: approvedBy 'lead@example.com'/;
    const without = await planned({ exceptions: [exception] });
    const r1 = await without.brokkr.verify({
      selection: without.selection,
      workspace: reactRepo(),
    });
    expect(r1.warnings.join("\n")).toMatch(ignored);
    const withApprover = await planned({
      exceptions: [exception],
      approvers: ["lead@example.com"],
    });
    const r2 = await withApprover.brokkr.verify({
      selection: withApprover.selection,
      workspace: reactRepo(),
    });
    expect(r2.warnings.join("\n")).not.toMatch(ignored);
  });

  it("applies the organization policy from the Brokkr home", async () => {
    const homeDir = tempDir("brokkr-home-");
    mkdirSync(join(homeDir, ".brokkr"));
    writeFileSync(join(homeDir, ".brokkr", "org-policy.yaml"), "allowedCommands: [node]\n");
    const { brokkr, executor, selection } = await planned({ homeDir });
    const report = await brokkr.verify({ selection, workspace: reactRepo() });
    expect(report.verdict).toBe("blocked");
    expect(report.policyDecisions.some((d) => d.layer === "organization")).toBe(true);
    expect(executor.calls).toEqual([]);
  });

  it("a profile whose policies are malformed is invalid-config", async () => {
    const profile = {
      name: "odd-policy",
      harnesses: [{ name: "qa-regression", version: "^1.0.0" }],
      overrides: { policies: { network: "sometimes" } },
    };
    const cwd = reactRepo();
    const brokkr = make(cwd, { profiles: [profile], executor: new MockExecutor({}) });
    const selection = await brokkr.resolve({ task: QA, profile: "odd-policy" });
    await expect(brokkr.verify({ selection, workspace: cwd })).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/invalid profile policies/),
    });
  });

  it("a listener that throws is logged and does not stop the run", async () => {
    const { lines, logger } = recordingLogger();
    const { brokkr, selection } = await planned({ logger });
    const report = await brokkr.verify({
      selection,
      workspace: reactRepo(),
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    expect(report.verdict).toBe("passed");
    expect(lines).toContainEqual({
      obj: { error: "Error: listener bug" },
      msg: "verification event listener threw",
    });
  });

  it("rejects a missing or empty workspace path", async () => {
    const { brokkr, selection } = await planned();
    for (const workspace of ["", undefined, 3])
      await expect(
        brokkr.verify({ selection, workspace: workspace as never }),
      ).rejects.toMatchObject({
        code: "invalid-config",
        message: "verify: workspace must be a directory path",
      });
  });

  it("an executor crash is an infra error carrying the run id in verification.failed", async () => {
    const { brokkr, selection } = await planned(
      {},
      {
        test: () => {
          throw new Error("sandbox unavailable");
        },
      },
    );
    const events: VerificationEvent[] = [];
    await expect(
      brokkr.verify({ selection, workspace: reactRepo(), onEvent: (e) => events.push(e) }),
    ).rejects.toMatchObject({
      code: "infra",
      message: "verification failed: Error: sandbox unavailable",
    });
    const failed = events.at(-1);
    expect(failed?.type).toBe("verification.failed");
    const started = events.find((e) => e.type === "verification.started");
    expect(failed?.type === "verification.failed" && failed.runId).toBe(
      started?.type === "verification.started" && started.runId,
    );
    expect(failed?.type === "verification.failed" && failed.error.code).toBe("infra");
  });

  it("a non-Error thrown by the executor is still reported as an infra error", async () => {
    const { brokkr, selection } = await planned(
      {},
      {
        test: () => {
          throw "socket closed";
        },
      },
    );
    const events: VerificationEvent[] = [];
    await expect(
      brokkr.verify({ selection, workspace: reactRepo(), onEvent: (e) => events.push(e) }),
    ).rejects.toMatchObject({ code: "infra", message: "verification failed: socket closed" });
    const failed = events.at(-1);
    expect(failed?.type === "verification.failed" && failed.error.message).toBe("socket closed");
  });

  it("a caller profile without policy overrides verifies under its harnesses alone", async () => {
    const profile = { name: "plain-qa", harnesses: [{ name: "qa-regression", version: "^1.0.0" }] };
    const cwd = reactRepo();
    const brokkr = make(cwd, {
      profiles: [profile],
      executor: new MockExecutor({ test: "passed" }),
    });
    const selection = await brokkr.resolve({ task: QA, profile: "plain-qa" });
    const report = await brokkr.verify({ selection, workspace: cwd });
    expect(report.verdict).toBe("passed");
    expect(report.policyDecisions.some((d) => d.layer === "task")).toBe(false);
  });
});

describe("Brokkr.verify selection integrity", () => {
  async function planned(homeDir = tempDir("brokkr-home-")) {
    const cwd = reactRepo();
    const executor = new MockExecutor({}, { fallback: "passed" });
    const brokkr = new Brokkr({ cwd, builtinDir: BUILTIN, homeDir, executor });
    return { cwd, brokkr, executor };
  }
  const reasons = (r: { reasons: string[] }) => r.reasons.join("\n");

  it("a structurally invalid selection is invalid-config", async () => {
    const { cwd, brokkr } = await planned();
    await expect(
      brokkr.verify({ selection: { schemaVersion: 1 } as never, workspace: cwd }),
    ).rejects.toMatchObject({ code: "invalid-config", message: /invalid selection/ });
  });

  it("a selection that names a profile its lock does not pin is blocked", async () => {
    const { cwd, brokkr, executor } = await planned();
    const s = await brokkr.resolve({ task: QA });
    const r = await brokkr.verify({
      selection: { ...s, profile: "frontend-strict" },
      workspace: cwd,
    });
    expect(r.verdict).toBe("blocked");
    expect(reasons(r)).toMatch(
      /selection names profile frontend-strict but the lock pins no profile/,
    );
    expect(executor.calls).toEqual([]);
  });

  it("a selection naming a profile that does not exist is blocked", async () => {
    const { cwd, brokkr } = await planned();
    const s = await brokkr.resolve({ task: QA });
    const r = await brokkr.verify({ selection: { ...s, profile: "ghost" }, workspace: cwd });
    expect(r.verdict).toBe("blocked");
    expect(reasons(r)).toMatch(/profile ghost is not available/);
  });

  it("a malformed caller profile named by the selection is a configuration error, not a finding", async () => {
    const cwd = reactRepo();
    const s = await make(cwd).resolve({ task: QA });
    const brokkr = make(cwd, {
      profiles: [{ name: "bad", harnesses: "all" } as never],
      executor: new MockExecutor({}),
    });
    await expect(
      brokkr.verify({ selection: { ...s, profile: "bad" }, workspace: cwd }),
    ).rejects.toMatchObject({ code: "invalid-config", message: /invalid profiles\[0\]/ });
  });

  it("a skill whose version was edited in the selection is blocked as modified", async () => {
    const { cwd, brokkr } = await planned();
    const s = await brokkr.resolve({ task: QA });
    const [first, ...rest] = s.skills;
    const forged: Selection = { ...s, skills: [{ ...first!, version: "9.9.9" }, ...rest] };
    const r = await brokkr.verify({ selection: forged, workspace: cwd });
    expect(r.verdict).toBe("blocked");
    expect(reasons(r)).toMatch(new RegExp(`skill ${first!.name}@9.9.9 modified`));
  });

  it("a selection that drops a resolved dependency is blocked", async () => {
    const homeDir = homeWith({
      "docs-plus": HARNESS(
        "docs-plus",
        "1.0.0",
        "dependsOn: [{ name: documentation, version: ^1.0.0 }]\n",
      ),
    });
    const { cwd, brokkr, executor } = await planned(homeDir);
    const s = await brokkr.resolve({
      task: QA,
      harnesses: [{ name: "docs-plus", version: "^1.0.0" }],
    });
    const forged: Selection = {
      ...s,
      harnesses: s.harnesses.filter((h) => h.name === "docs-plus"),
    };
    const r = await brokkr.verify({ selection: forged, workspace: cwd });
    expect(r.verdict).toBe("blocked");
    expect(reasons(r)).toMatch(/harness documentation is not part of the selection/);
    expect(executor.calls).toEqual([]);
  });
});
