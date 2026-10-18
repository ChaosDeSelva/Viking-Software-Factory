import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ApprovedException,
  CheckDefinition,
  ComposedHarness,
  HarnessManifest,
  ResolvedHarnessSet,
} from "@brokkr/core";
import { readReport } from "@brokkr/evidence";
import { LocalProcessExecutor } from "./executor.js";
import {
  readGeneratedBundles,
  runVerification,
  type CheckExecutionRequest,
  type CheckExecutionResult,
  type CheckExecutor,
  type VerifyEvent,
  type VerifyOptions,
} from "./index.js";
import { tmp } from "../test/helpers.js";

const PATH = dirname(process.execPath);
const NOW = new Date("2026-10-14T13:00:00Z");

function manifest(
  checks: CheckDefinition[],
  policies?: Partial<HarnessManifest["policies"]>,
): HarnessManifest {
  return {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Harness",
    metadata: { name: "h", version: "1.0.0", description: "test" },
    compatibility: { platforms: ["darwin", "linux"], taskTypes: [] },
    skills: { required: [], optional: [] },
    workflow: { stages: [] },
    checks,
    policies: {
      network: "allow",
      destructiveCommands: "deny",
      requireApprovalFor: [],
      ...policies,
    },
    evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: false },
  };
}

function harness(
  checks: CheckDefinition[],
  opts: { trusted?: boolean; policies?: Partial<HarnessManifest["policies"]> } = {},
): { set: ResolvedHarnessSet; composed: ComposedHarness; dir: string } {
  const dir = tmp("brokkr-harness-");
  const m = manifest(checks, opts.policies);
  const trusted = opts.trusted ?? true;
  const set: ResolvedHarnessSet = {
    harnesses: [
      {
        manifest: m,
        dir,
        digest: `sha256:${"1".repeat(64)}`,
        source: trusted ? "project" : "external",
        sourceRef: trusted ? "project" : "external:vendor",
        trust: trusted ? "trusted" : "untrusted",
        skills: [],
        executionAllowed: trusted,
        requestedBy: ["request"],
      },
    ],
    skills: {},
  };
  const composed: ComposedHarness = {
    harnesses: [{ name: "h", version: "1.0.0" }],
    checks: checks.map((c) => ({ ...c, from: ["h@1.0.0"] })),
    policies: m.policies,
    skills: { required: [], optional: [] },
    requiredBy: {},
    workflow: { stages: [] },
    evidence: m.evidence,
    aiReview: { criteria: [] },
    executionAllowed: trusted,
    warnings: [],
  };
  return { set, composed, dir };
}

function check(
  id: string,
  command: string[],
  extra: Partial<CheckDefinition> = {},
): CheckDefinition {
  return { id, command, required: true, timeoutSeconds: 30, ...extra };
}

class FakeExecutor implements CheckExecutor {
  requests: CheckExecutionRequest[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    private readonly behave: (
      req: CheckExecutionRequest,
    ) => Partial<CheckExecutionResult> | Promise<Partial<CheckExecutionResult>> = () => ({}),
  ) {}
  async execute(req: CheckExecutionRequest): Promise<CheckExecutionResult> {
    this.requests.push(req);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (req.logFile) {
      mkdirSync(dirname(req.logFile), { recursive: true });
      writeFileSync(req.logFile, `ran ${req.checkId}\n`);
    }
    const extra = await this.behave(req);
    this.active--;
    return {
      checkId: req.checkId,
      state: "passed",
      exitCode: 0,
      signal: null,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      durationMs: 5,
      outputTail: "",
      outputBytes: 10,
      truncated: false,
      secretFindings: 0,
      ...extra,
    };
  }
}

function workspace(): string {
  const ws = tmp("brokkr-ws-");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
  return ws;
}

async function verify(
  h: ReturnType<typeof harness>,
  executor: CheckExecutor,
  over: Partial<VerifyOptions> = {},
) {
  const ws = over.workspace ?? workspace();
  const events: VerifyEvent[] = [];
  const outcome = await runVerification({
    workspace: ws,
    set: h.set,
    composed: h.composed,
    lockDigest: `sha256:${"9".repeat(64)}`,
    executor,
    env: { PATH, HOME: "/home/u", GITHUB_TOKEN: "ghp_supersecretvalue" },
    now: () => NOW,
    onEvent: (e) => events.push(e),
    trustMode: "developer",
    ...over,
  });
  return { ...outcome, events, ws };
}

function exception(over: Partial<ApprovedException>): ApprovedException {
  return {
    id: "exc-1",
    policy: "check:visual",
    scope: {},
    reason: "baseline unavailable",
    approvedBy: "owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: [],
    ...over,
  };
}

describe("runVerification", () => {
  it("runs every check, writes an intact report and streams events", async () => {
    const h = harness([
      check("a", ["node", "check.mjs"]),
      check("b", ["node", "check.mjs"], { required: false }),
    ]);
    const executor = new FakeExecutor();
    const { report, runDir, exitCode, events, interrupted } = await verify(h, executor);
    expect(report.verdict).toBe("passed");
    expect(exitCode).toBe(0);
    expect(interrupted).toBe(false);
    expect(executor.requests.map((r) => r.checkId)).toEqual(["a", "b"]);
    expect(report.checks.map((c) => [c.id, c.state, c.log])).toEqual([
      ["a", "passed", "logs/a.log"],
      ["b", "passed", "logs/b.log"],
    ]);
    expect(report.harness).toEqual({
      name: "h",
      version: "1.0.0",
      lockDigest: `sha256:${"9".repeat(64)}`,
    });
    expect(report.repository.commitSha).toBe("unborn");
    expect(report.repository.dirtyTreeDigest).toMatch(/^sha256:/);
    expect(events.map((e) => e.type)).toEqual([
      "run-start",
      "check-start",
      "check-end",
      "check-start",
      "check-end",
      "run-end",
    ]);
    const stored = await readReport(runDir);
    expect(stored.integrity.status).toBe("ok");
    expect(existsSync(join(runDir, "report.md"))).toBe(true);
  });

  it("filters the environment, applies the network policy and exposes artifact dirs", async () => {
    const h = harness([check("a", ["node", "check.mjs"], { env: ["DISPLAY", "NPM_TOKEN"] })], {
      policies: { network: "deny" },
    });
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor, {
      env: {
        PATH,
        HOME: "/h",
        DISPLAY: ":1",
        NPM_TOKEN: "npm_secretsecret",
        HTTPS_PROXY: "http://corp",
      },
    });
    const env = executor.requests[0]!.env;
    expect(env.DISPLAY).toBe(":1");
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(env.BROKKR_TEST_RESULTS_DIR).toMatch(/test-results\/a$/);
    expect(env.BROKKR_SCREENSHOTS_DIR).toMatch(/screenshots\/a$/);
    expect(report.warnings.join()).toMatch(/NPM_TOKEN.*not passed/);
  });

  it("blocks untrusted harnesses without executing anything", async () => {
    const h = harness([check("a", ["node", "check.mjs"])], { trusted: false });
    const executor = new FakeExecutor();
    const { report, exitCode } = await verify(h, executor);
    expect(executor.requests).toEqual([]);
    expect(report.verdict).toBe("blocked");
    expect(exitCode).toBe(4);
    expect(report.reasons[0]).toMatch(/untrusted_source/);
    expect(report.checks[0]).toMatchObject({ state: "skipped", reason: "untrusted_source" });
  });

  it("blocks a plan containing a destructive command", async () => {
    const h = harness([check("ok", ["node", "check.mjs"]), check("wipe", ["rm", "-rf", "/"])]);
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor);
    expect(executor.requests).toEqual([]);
    expect(report.verdict).toBe("blocked");
    expect(report.checks.map((c) => c.reason)).toEqual(["policy_denied", "policy_denied"]);
  });

  it("blocks on lockfile integrity problems", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor, { lockProblems: ["harness h@1.0.0 modified"] });
    expect(executor.requests).toEqual([]);
    expect(report.verdict).toBe("blocked");
    expect(report.reasons.join()).toMatch(/lock_integrity: harness h@1.0.0 modified/);
    expect(report.policyDecisions).toContainEqual(
      expect.objectContaining({ policy: "lock-integrity", outcome: "deny" }),
    );
  });

  it("waived checks are skipped with the exception id and recorded", async () => {
    const h = harness([
      check("a", ["node", "check.mjs"]),
      check("visual", ["node", "check.mjs"], { waivable: true }),
    ]);
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor, {
      exceptions: [exception({})],
      task: { id: "UI-1", title: "t", description: "" },
    });
    expect(executor.requests.map((r) => r.checkId)).toEqual(["a"]);
    expect(report.checks[1]).toMatchObject({
      state: "skipped",
      reason: "exception",
      exceptionId: "exc-1",
    });
    expect(report.exceptions).toEqual([
      expect.objectContaining({
        id: "exc-1",
        appliedTo: { task: "UI-1", harnesses: ["h@1.0.0"], checkId: "visual" },
      }),
    ]);
    expect(report.verdict).toBe("passed");
    expect(report.reasons).toContain("required check 'visual' waived by exception exc-1");
  });

  it("network-dependent checks under network deny are skipped network_denied, never passed", async () => {
    const h = harness([check("audit", ["pnpm", "audit", "--json"])], {
      policies: { network: "deny" },
    });
    const executor = new FakeExecutor();
    const pnpmDir = dirname(execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim());
    const { report } = await verify(h, executor, { env: { PATH: `${pnpmDir}:${PATH}` } });
    expect(executor.requests).toEqual([]);
    expect(report.checks[0]).toMatchObject({ state: "skipped", reason: "network_denied" });
    expect(report.verdict).toBe("incomplete");
  });

  it("an approved network-access exception lets the audit run without the deny proxy", async () => {
    const h = harness([check("audit", ["pnpm", "audit", "--json"])], {
      policies: { network: "deny" },
    });
    const executor = new FakeExecutor();
    const pnpmDir = dirname(execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim());
    const { report } = await verify(h, executor, {
      env: { PATH: `${pnpmDir}:${PATH}` },
      exceptions: [exception({ id: "net-1", policy: "network-access:audit" })],
    });
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]!.env.HTTPS_PROXY).toBeUndefined();
    expect(report.verdict).toBe("passed");
    expect(report.exceptions.map((e) => e.id)).toEqual(["net-1"]);
  });

  it("project allowNetworkFor runs the audit without the deny proxy and records it", async () => {
    const h = harness([check("audit", ["pnpm", "audit", "--json"])], {
      policies: { network: "deny" },
    });
    const executor = new FakeExecutor();
    const pnpmDir = dirname(execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim());
    const { report } = await verify(h, executor, {
      env: { PATH: `${pnpmDir}:${PATH}` },
      layers: [{ layer: "project", policy: { allowNetworkFor: ["audit"] } }],
    });
    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]!.env.HTTPS_PROXY).toBeUndefined();
    expect(report.verdict).toBe("passed");
    expect(report.policyDecisions).toContainEqual(
      expect.objectContaining({
        policy: "network-access",
        outcome: "approved",
        layer: "project",
        checkId: "audit",
      }),
    );
  });

  it("a required check whose tool is missing is skipped and makes the run incomplete", async () => {
    const h = harness([check("lint", ["definitely-missing-linter"])]);
    const executor = new FakeExecutor();
    const { report, exitCode } = await verify(h, executor);
    expect(executor.requests).toEqual([]);
    expect(report.checks[0]).toMatchObject({ state: "skipped", reason: "missing_tool" });
    expect(report.checks[0]!.message).toMatch(/not found on PATH/);
    expect(report.verdict).toBe("incomplete");
    expect(exitCode).toBe(1);
  });

  it("an interrupted run cancels remaining checks, keeps evidence and exits 130", async () => {
    const controller = new AbortController();
    const h = harness([
      check("first", ["node", "check.mjs"]),
      check("slow", ["node", "check.mjs"]),
      check("never", ["node", "check.mjs"]),
    ]);
    const executor = new FakeExecutor((req) => {
      if (req.checkId === "slow") {
        controller.abort();
        return { state: "cancelled", reason: "cancelled", exitCode: null, signal: "SIGTERM" };
      }
      return {};
    });
    const { report, exitCode, interrupted, runDir } = await verify(h, executor, {
      signal: controller.signal,
    });
    expect(interrupted).toBe(true);
    expect(exitCode).toBe(130);
    expect(report.interrupted).toBe(true);
    expect(report.checks.map((c) => c.state)).toEqual(["passed", "cancelled", "cancelled"]);
    expect(report.checks[2]!.message).toMatch(/not started/);
    expect(report.verdict).toBe("incomplete");
    expect(readFileSync(join(runDir, "logs", "first.log"), "utf8")).toBe("ran first\n");
    expect((await readReport(runDir)).integrity.status).toBe("ok");
  });

  it("secret findings in output block the run", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const { report } = await verify(h, new FakeExecutor(() => ({ secretFindings: 1 })));
    expect(report.verdict).toBe("blocked");
    expect(report.reasons[0]).toMatch(/secret_exposure/);
  });

  it("passes a redactor that knows the caller's secret values", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const executor = new FakeExecutor();
    await verify(h, executor);
    const redactor = executor.requests[0]!.createRedactor!();
    expect(redactor.write("token ghp_supersecretvalue here\n")).not.toContain(
      "ghp_supersecretvalue",
    );
  });

  it("secrets written into test results block the run and are redacted at rest", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const executor = new FakeExecutor((req) => {
      const dir = req.env.BROKKR_TEST_RESULTS_DIR!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "out.txt"), `leak ${"AKIA" + "IOSFODNN7EXAMPLE"}\n`);
      return {};
    });
    const { report, runDir } = await verify(h, executor);
    expect(report.verdict).toBe("blocked");
    const text = readFileSync(join(runDir, "test-results", "a", "out.txt"), "utf8");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED:aws-access-key]");
  });

  it("runs consecutive parallel checks concurrently and others sequentially", async () => {
    const h = harness([
      check("p1", ["node", "check.mjs"], { parallel: true }),
      check("p2", ["node", "check.mjs"], { parallel: true }),
      check("s", ["node", "check.mjs"]),
    ]);
    // Each parallel check waits (up to 3 s) until the other one is running too.
    const executor: FakeExecutor = new FakeExecutor(async (req) => {
      const deadline = Date.now() + 3000;
      while (req.checkId !== "s" && executor.active < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return {};
    });
    const { report } = await verify(h, executor);
    expect(executor.maxActive).toBe(2);
    expect(report.checks.map((c) => c.id)).toEqual(["p1", "p2", "s"]);
  });

  it("expands {{harnessDir}} to the declaring harness directory", async () => {
    const h = harness([check("scan", ["node", "{{harnessDir}}/scripts/scan.mjs"])]);
    mkdirSync(join(h.dir, "scripts"));
    writeFileSync(join(h.dir, "scripts", "scan.mjs"), "");
    const executor = new FakeExecutor();
    await verify(h, executor);
    expect(executor.requests[0]!.command).toEqual(["node", join(h.dir, "scripts", "scan.mjs")]);
  });

  it("project requiredCheckIds make an optional check required and flag missing ones", async () => {
    const h = harness([check("lint", ["node", "check.mjs"], { required: false })]);
    const { report } = await verify(h, new FakeExecutor(() => ({ state: "failed", exitCode: 1 })), {
      layers: [{ layer: "project", policy: { requiredCheckIds: ["lint", "e2e"] } }],
    });
    expect(report.checks[0]).toMatchObject({ id: "lint", required: true, state: "failed" });
    expect(report.verdict).toBe("failed");
    expect(report.reasons.join("\n")).toMatch(/required check 'e2e' is not defined/);
  });

  it("a required check with an unmet when guard is not_applicable and does not block a pass", async () => {
    const h = harness([
      check("unit", ["node", "check.mjs"]),
      check("e2e", ["node", "check.mjs"], { when: { anyFileExists: ["playwright.config.ts"] } }),
    ]);
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor);
    expect(executor.requests.map((r) => r.checkId)).toEqual(["unit"]);
    expect(report.checks[1]).toMatchObject({
      id: "e2e",
      required: true,
      requiredBy: "harness",
      state: "skipped",
      reason: "not_applicable",
    });
    expect(report.verdict).toBe("passed");
    expect(report.reasons).toContain(
      "required check 'e2e' not applicable (excluded from required gates)",
    );
  });

  it("a not-applicable check forced by requiredCheckIds stays incomplete", async () => {
    const h = harness([
      check("unit", ["node", "check.mjs"]),
      check("e2e", ["node", "check.mjs"], { when: { anyFileExists: ["playwright.config.ts"] } }),
    ]);
    const { report } = await verify(h, new FakeExecutor(), {
      layers: [{ layer: "project", policy: { requiredCheckIds: ["e2e"] } }],
    });
    expect(report.checks[1]).toMatchObject({ requiredBy: "policy", reason: "not_applicable" });
    expect(report.verdict).toBe("incomplete");
  });

  it("records policy sources and flags workspace-supplied exceptions (B2 review I5)", async () => {
    const h = harness([
      check("a", ["node", "check.mjs"]),
      check("visual", ["node", "check.mjs"], { waivable: true }),
    ]);
    const sources = [
      {
        kind: "exceptions" as const,
        path: ".brokkr/exceptions.yaml",
        origin: "workspace_supplied" as const,
        digest: `sha256:${"e".repeat(64)}`,
      },
    ];
    const { report } = await verify(h, new FakeExecutor(), {
      exceptions: [exception({})],
      policySources: sources,
    });
    expect(report.policySources).toEqual(sources);
    expect(report.exceptions[0]).toMatchObject({ id: "exc-1", origin: "workspace_supplied" });
    expect(report.policyDecisions).toContainEqual(
      expect.objectContaining({
        policy: "policy-source",
        outcome: "warn",
        message: expect.stringMatching(/exceptions.*workspace_supplied/),
      }),
    );
  });

  it("a script run that would trigger a dependency install is denied, not run", async () => {
    const ws = workspace();
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ scripts: { test: "x" }, dependencies: { "left-pad": "1.3.0" } }),
    );
    const h = harness([check("unit", ["pnpm", "test"])]);
    const executor = new FakeExecutor();
    const pnpmDir = dirname(execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim());
    const { report, exitCode } = await verify(h, executor, {
      workspace: ws,
      env: { PATH: `${pnpmDir}:${PATH}` },
    });
    expect(executor.requests).toEqual([]);
    expect(report.checks[0]).toMatchObject({ state: "skipped", reason: "policy_denied" });
    expect(report.checks[0]!.message).toMatch(/node_modules.*install-dependencies/);
    expect(report.verdict).toBe("blocked");
    expect(exitCode).toBe(4);
  });

  it("accepts a caller-supplied runRoot and signingKey (SDK options)", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const runRoot = join(tmp(), "runs");
    const signingKey = randomBytes(32);
    const { runDir } = await verify(h, new FakeExecutor(), { runRoot, signingKey });
    expect(dirname(runDir)).toBe(runRoot);
    expect((await readReport(runDir, { key: signingKey })).integrity.status).toBe("ok");
    expect((await readReport(runDir)).integrity.problems.join()).toMatch(/signature mismatch/);
  });

  it("records the trust mode in the report", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    const { report } = await verify(h, new FakeExecutor());
    expect(report.trustMode).toBe("developer");
  });

  describe("workspace-untrusted mode (audit C1/C2)", () => {
    const untrusted = { trustMode: "workspace-untrusted" as const, lockProblems: [] };

    it("is the default and blocks when no lock verification was supplied", async () => {
      const h = harness([check("a", ["node", "check.mjs"])]);
      const executor = new FakeExecutor();
      const { report } = await verify(h, executor, { trustMode: undefined as never });
      expect(report.trustMode).toBe("workspace-untrusted");
      expect(report.verdict).toBe("blocked");
      expect(report.reasons.join()).toMatch(/lock_integrity: no lock verification/);
      expect(executor.requests).toEqual([]);
    });

    it("harness-declared waivable checks cannot be waived; only org/project policy can allow it", async () => {
      const h = harness([
        check("a", ["node", "check.mjs"]),
        check("visual", ["node", "check.mjs"], { waivable: true }),
      ]);
      const executor = new FakeExecutor();
      const { report } = await verify(h, executor, {
        ...untrusted,
        exceptions: [exception({ approvedBy: "lead" })],
        approvers: ["lead"],
      });
      expect(executor.requests.map((r) => r.checkId)).toEqual(["a", "visual"]);
      expect(report.exceptions).toEqual([]);
      const viaProject = await verify(h, new FakeExecutor(), {
        ...untrusted,
        exceptions: [exception({ approvedBy: "lead" })],
        approvers: ["lead"],
        layers: [{ layer: "project", policy: { waivable: ["check:visual"] } }],
      });
      expect(viaProject.report.checks[1]).toMatchObject({ state: "skipped", exceptionId: "exc-1" });
    });

    it("exceptions approved by anyone but a caller-trusted approver are ignored", async () => {
      const h = harness([
        check("a", ["node", "check.mjs"]),
        check("visual", ["node", "check.mjs"]),
      ]);
      const { report } = await verify(h, new FakeExecutor(), {
        ...untrusted,
        exceptions: [exception({ approvedBy: "security-team@example.com" })],
        approvers: ["lead"],
        layers: [{ layer: "project", policy: { waivable: ["check:visual"] } }],
      });
      expect(report.checks[1]!.state).toBe("passed");
      expect(report.warnings.join()).toMatch(
        /exc-1.*approvedBy 'security-team@example.com' is not a caller-trusted approver/,
      );
    });
  });

  it("a check whose binary is an alias of rm blocks the run and never executes (fix round 2, C1)", async () => {
    const { chmodSync, linkSync } = await import("node:fs");
    const bin = join(tmp(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "rm"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "rm"), 0o755);
    linkSync(join(bin, "rm"), join(bin, "zap"));
    const h = harness([check("a", ["node", "check.mjs"]), check("wipe", ["zap", "-rf", "victim"])]);
    const executor = new FakeExecutor();
    const { report } = await verify(h, executor, { env: { PATH: `${bin}:${PATH}` } });
    expect(executor.requests.map((r) => r.checkId)).toEqual(["a"]);
    expect(report.checks[1]).toMatchObject({ state: "skipped", reason: "policy_denied" });
    expect(report.verdict).toBe("blocked");
    expect(report.reasons.join()).toMatch(/destructive-commands: 'zap' resolves to 'rm'/);
  });

  describe("Brokkr home isolation in workspace-untrusted mode (fix round 2, I3)", () => {
    function poisoner(ws: string, target: string): void {
      // A check that tries to plant exceptions/org policy in "the" Brokkr home.
      writeFileSync(
        join(ws, "poison.mjs"),
        `import { mkdirSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(target)} || (process.env.HOME + "/.brokkr");
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/exceptions.yaml", "exceptions: []\\n");
writeFileSync(dir + "/org-policy.yaml", "waivable: [check:unit]\\n");
console.log("HOME=" + process.env.HOME + " XDG=" + process.env.XDG_CONFIG_HOME);
`,
      );
    }

    it("checks run with a scratch HOME and XDG_CONFIG_HOME, never the real home", async () => {
      const ws = workspace();
      const home = tmp("brokkr-home-");
      poisoner(ws, "");
      const h = harness([check("unit", ["node", "poison.mjs"])]);
      const { report, runDir } = await verify(h, new LocalProcessExecutor(), {
        workspace: ws,
        home,
        trustMode: "workspace-untrusted",
        lockProblems: [],
        env: { PATH, HOME: home },
      });
      const log = readFileSync(join(runDir, "logs", "unit.log"), "utf8");
      expect(log).not.toContain(`HOME=${home} `);
      expect(log).toMatch(/XDG=\S+\.config/);
      expect(existsSync(join(home, ".brokkr", "exceptions.yaml"))).toBe(false);
      expect(report.verdict).toBe("passed");
    });

    it("a check that writes into the Brokkr home fails the run with home_tampered", async () => {
      const ws = workspace();
      const home = tmp("brokkr-home-");
      poisoner(ws, join(home, ".brokkr"));
      const h = harness([check("unit", ["node", "poison.mjs"])]);
      const { report, exitCode } = await verify(h, new LocalProcessExecutor(), {
        workspace: ws,
        home,
        trustMode: "workspace-untrusted",
        lockProblems: [],
        env: { PATH, HOME: home },
      });
      expect(report.verdict).toBe("blocked");
      expect(exitCode).toBe(4);
      expect(report.reasons.join()).toMatch(/home_tampered: .*exceptions\.yaml.*org-policy\.yaml/);
    });

    it("developer mode keeps the caller's HOME", async () => {
      const ws = workspace();
      const home = tmp("brokkr-home-");
      writeFileSync(join(ws, "h.mjs"), "console.log('HOME=' + process.env.HOME + ' ');\n");
      const h = harness([check("unit", ["node", "h.mjs"])]);
      const { runDir } = await verify(h, new LocalProcessExecutor(), {
        workspace: ws,
        home,
        env: { PATH, HOME: home },
      });
      expect(readFileSync(join(runDir, "logs", "unit.log"), "utf8")).toContain(`HOME=${home} `);
    });
  });

  it("secrets in generated bundles block the run through the shared reader", async () => {
    const ws = workspace();
    mkdirSync(join(ws, ".brokkr", "generated"), { recursive: true });
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    writeFileSync(join(ws, ".brokkr", "generated", "a.md"), `key ${key}\n`);
    const h = harness([check("a", ["node", "check.mjs"])]);
    const one = await verify(h, new FakeExecutor(), {
      workspace: ws,
      readBundles: () => readGeneratedBundles(ws),
    });
    expect(one.report.verdict).toBe("blocked");
    const two = await verify(h, new FakeExecutor(), {
      readBundles: async () => ({
        files: [{ file: "b.md", text: `key ${key}` }],
        warnings: ["w1"],
      }),
    });
    expect(two.report.verdict).toBe("blocked");
    expect(two.report.warnings).toContain("w1");
  });

  it("refuses to run in a workspace that does not exist", async () => {
    const h = harness([check("a", ["node", "check.mjs"])]);
    await expect(
      runVerification({
        workspace: join(tmp(), "missing"),
        set: h.set,
        composed: h.composed,
        lockDigest: "none",
        executor: new FakeExecutor(),
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });
});
