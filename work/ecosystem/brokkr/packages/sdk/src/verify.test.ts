import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VerificationReportSchema } from "@brokkr/core";
import { describe, expect, it } from "vitest";
import { runsRootFor } from "@brokkr/evidence";
import { Brokkr, VERIFICATION_EVENT_TYPES, type VerificationEvent } from "./index.js";
import { MockExecutor } from "./testing.js";
import { BUILTIN, reactRepo, tempDir, writeConfig } from "../test/fixtures.js";

const QA_TASK = {
  id: "QA-7",
  title: "Regression pass",
  description: "Independent regression run",
  taskTypes: ["qa"],
};

async function setup(
  script: ConstructorParameters<typeof MockExecutor>[0],
  trust: "workspace-untrusted" | "developer" = "workspace-untrusted",
) {
  const cwd = reactRepo();
  const executor = new MockExecutor(script);
  const homeDir = tempDir("brokkr-home-");
  const brokkr = new Brokkr({
    cwd,
    builtinDir: BUILTIN,
    homeDir,
    executor,
    trust,
  });
  const selection = await brokkr.resolve({
    task: QA_TASK,
    harnesses: [{ name: "qa-regression", version: "^1.0.0" }],
  });
  return { cwd, brokkr, executor, selection, homeDir };
}

const types = (events: VerificationEvent[]) => events.map((e) => e.type);

describe("Brokkr.verify with an injected executor", () => {
  it("runs checks through the executor inside the workspace and returns a schema-valid report", async () => {
    const { cwd, brokkr, executor, selection, homeDir } = await setup({ test: "passed" });
    const workspace = reactRepo();
    const report = await brokkr.verify({ selection, workspace, correlationId: "exec-42" });
    expect(VerificationReportSchema.safeParse(report).success).toBe(true);
    expect(report.verdict).toBe("passed");
    expect(report.executionId).toBe("exec-42");
    expect(report.taskId).toBe("QA-7");
    expect(report.harness.lockDigest).toBe(selection.lock.digest);
    expect(executor.calls.map((c) => c.checkId)).toEqual(["test"]);
    expect(executor.calls[0]?.workspace).toBe(workspace);
    expect(executor.calls[0]?.command).toEqual(["pnpm", "test"]);
    const stored = await brokkr.readReport(join(runsRootFor(workspace, homeDir), report.id));
    expect(stored.integrity.status).toBe("ok");
    expect(stored.report.id).toBe(report.id);
    void cwd;
  });

  it("streams the §13.3 events with envelope fields and a gapless per-run sequence", async () => {
    const { brokkr, selection } = await setup({ test: "passed" });
    const events: VerificationEvent[] = [];
    await brokkr.verify({
      selection,
      workspace: reactRepo(),
      correlationId: "exec-1",
      onEvent: (e) => events.push(e),
    });
    expect(types(events)[0]).toBe("verification.started");
    expect(types(events).at(-1)).toBe("verification.completed");
    expect(types(events)).toContain("verification.check.started");
    expect(types(events)).toContain("verification.check.completed");
    for (const e of events) {
      expect(VERIFICATION_EVENT_TYPES).toContain(e.type);
      expect(e).toMatchObject({ schemaVersion: 1, correlationId: "exec-1" });
      expect(e.eventId).toMatch(/^evt_/);
      expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
    }
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    const done = events.at(-1);
    expect(done?.type === "verification.completed" && done.verdict).toBe("passed");
    const test = events.find(
      (e) => e.type === "verification.check.completed" && e.checkId === "test",
    );
    expect(test?.type === "verification.check.completed" && test.result.state).toBe("passed");
  });

  it("a failing required check gives a failed verdict (Brokkr's verdict, not the caller's)", async () => {
    const { brokkr, selection } = await setup({ test: { state: "failed", exitCode: 1 } });
    const report = await brokkr.verify({ selection, workspace: reactRepo() });
    expect(report.verdict).toBe("failed");
  });

  it("an aborted run reports verification.cancelled and an interrupted report", async () => {
    const { brokkr, selection } = await setup({ test: { state: "passed", delayMs: 5_000 } });
    const ac = new AbortController();
    const events: VerificationEvent[] = [];
    const pending = brokkr.verify({
      selection,
      workspace: reactRepo(),
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "verification.check.started") ac.abort();
      },
    });
    const report = await pending;
    expect(report.interrupted).toBe(true);
    expect(report.verdict).not.toBe("passed");
    expect(types(events).at(-1)).toBe("verification.cancelled");
  });

  it("a modified harness blocks the run and nothing executes", async () => {
    const { brokkr, executor, selection } = await setup({ test: "passed" });
    const forged = {
      ...selection,
      harnesses: selection.harnesses.map((h) => ({ ...h, digest: `sha256:${"1".repeat(64)}` })),
    };
    const report = await brokkr.verify({ selection: forged, workspace: reactRepo() });
    expect(report.verdict).toBe("blocked");
    expect(report.reasons.join("\n")).toMatch(/lock_integrity/);
    expect(executor.calls).toEqual([]);
  });

  it("an invalid request emits verification.failed and throws a typed error", async () => {
    const { brokkr, selection } = await setup({ test: "passed" });
    const events: VerificationEvent[] = [];
    await expect(
      brokkr.verify({
        selection,
        workspace: join(tempDir(), "does-not-exist"),
        onEvent: (e) => events.push(e),
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
    expect(types(events)).toEqual(["verification.failed"]);
    const failed = events[0];
    expect(failed?.type === "verification.failed" && failed.error.code).toBe("invalid-config");
  });

  it("developer mode reads policy and exceptions from cwd, never from the workspace", async () => {
    const { cwd, brokkr, selection } = await setup({ test: "passed" }, "developer");
    const workspace = reactRepo();
    // A malformed exceptions file planted in the workspace by an agent is never read.
    mkdirSync(join(workspace, ".brokkr"), { recursive: true });
    writeFileSync(join(workspace, ".brokkr", "exceptions.yaml"), "exceptions: [ {bogus: 1} ]\n");
    expect((await brokkr.verify({ selection, workspace })).verdict).toBe("passed");
    // The same file in the trusted cwd is read (and rejected).
    mkdirSync(join(cwd, ".brokkr"), { recursive: true });
    writeFileSync(join(cwd, ".brokkr", "exceptions.yaml"), "exceptions: [ {bogus: 1} ]\n");
    await expect(brokkr.verify({ selection, workspace })).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("developer mode: project policy in cwd applies to the run", async () => {
    const { cwd, brokkr, executor, selection } = await setup({ test: "passed" }, "developer");
    writeConfig(cwd, "version: 1\nharnesses: []\npolicies:\n  allowedCommands: [node]\n");
    const report = await brokkr.verify({ selection, workspace: reactRepo() });
    expect(report.verdict).toBe("blocked");
    expect(executor.calls).toEqual([]);
    expect(JSON.stringify(report.policyDecisions)).toMatch(/allow/);
    void readFileSync;
  });
});

function scriptRepo(check: string): string {
  const dir = tempDir("brokkr-sdk-real-");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "real", private: true, scripts: { test: "node check.mjs" } }),
  );
  writeFileSync(join(dir, "check.mjs"), check);
  return dir;
}

describe("Brokkr.verify with the default LocalProcessExecutor", () => {
  it("really runs the check and stores its log as evidence", { timeout: 120_000 }, async () => {
    const cwd = reactRepo();
    const homeDir = tempDir("brokkr-home-");
    const brokkr = new Brokkr({ cwd, builtinDir: BUILTIN, homeDir });
    const selection = await brokkr.resolve({
      task: QA_TASK,
      harnesses: [{ name: "qa-regression", version: "^1.0.0" }],
    });
    // No dependencies: pnpm 12 would otherwise try to install them before `pnpm test`.
    const ok = scriptRepo("console.log(42);\n");
    const passed = await brokkr.verify({ selection, workspace: ok });
    expect(passed.verdict).toBe("passed");
    const check = passed.checks.find((c) => c.id === "test");
    expect(check).toMatchObject({ state: "passed", exitCode: 0, log: "logs/test.log" });
    // Runs are stored outside the workspace, under the Brokkr home (audit I2).
    const runDir = join(runsRootFor(ok, homeDir), passed.id);
    expect(readFileSync(join(runDir, "logs", "test.log"), "utf8")).toContain("42");
    expect((await brokkr.readReport(runDir)).integrity.status).toBe("ok");

    const bad = scriptRepo("process.exit(3);\n");
    expect((await brokkr.verify({ selection, workspace: bad })).verdict).toBe("failed");
  });
});

describe("review I2: generated bundles are read only inside the workspace", () => {
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  async function run(prepareWorkspace: (ws: string) => void) {
    const { brokkr, selection } = await setup({ test: "passed" });
    const workspace = reactRepo();
    prepareWorkspace(workspace);
    return brokkr.verify({ selection, workspace });
  }
  function outsideSecret(): string {
    const dir = tempDir("brokkr-outside-");
    mkdirSync(join(dir, "deep"));
    writeFileSync(join(dir, "deep", "creds.env"), `AWS_ACCESS_KEY_ID=${AWS}\n`);
    return dir;
  }

  it("a symlinked .brokkr/generated pointing outside is refused, not read", async () => {
    const report = await run((ws) => {
      mkdirSync(join(ws, ".brokkr"), { recursive: true });
      symlinkSync(outsideSecret(), join(ws, ".brokkr", "generated"));
    });
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/generated.*symlink/);
  });

  it("a symlink to / is refused promptly", async () => {
    const started = Date.now();
    const report = await run((ws) => {
      mkdirSync(join(ws, ".brokkr"), { recursive: true });
      symlinkSync("/", join(ws, ".brokkr", "generated"));
    });
    expect(report.verdict).toBe("passed");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("symlinked files and a symlinked .brokkr are skipped; real bundle secrets still block", async () => {
    const linkedFile = await run((ws) => {
      mkdirSync(join(ws, ".brokkr", "generated"), { recursive: true });
      symlinkSync(
        join(outsideSecret(), "deep", "creds.env"),
        join(ws, ".brokkr", "generated", "x.md"),
      );
    });
    expect(linkedFile.verdict).toBe("passed");
    const linkedRoot = await run((ws) => {
      const outside = tempDir("brokkr-outside-root-");
      mkdirSync(join(outside, "generated"));
      writeFileSync(join(outside, "generated", "a.md"), `key ${AWS}\n`);
      symlinkSync(outside, join(ws, ".brokkr"));
    });
    expect(linkedRoot.verdict).toBe("passed");
    const real = await run((ws) => {
      mkdirSync(join(ws, ".brokkr", "generated"), { recursive: true });
      writeFileSync(join(ws, ".brokkr", "generated", "CLAUDE.md"), `key ${AWS}\n`);
    });
    expect(real.verdict).toBe("blocked");
  });
});

describe("fix round 2 N2: bundles are read after the checks, at read time, without following links", () => {
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  function swapRepo(swap: string): string {
    const dir = scriptRepo(swap);
    mkdirSync(join(dir, ".brokkr", "generated"), { recursive: true });
    writeFileSync(join(dir, ".brokkr", "generated", "a.md"), "benign\n");
    return dir;
  }
  async function verifyReal(workspace: string) {
    const brokkr = new Brokkr({ cwd: reactRepo(), builtinDir: BUILTIN, homeDir: tempDir("h-") });
    const selection = await brokkr.resolve({
      task: QA_TASK,
      harnesses: [{ name: "qa-regression", version: "^1.0.0" }],
    });
    return brokkr.verify({ selection, workspace });
  }

  it("a check that swaps a bundle file for a symlink to a host secret: never read, swap reported", async () => {
    const outside = tempDir("brokkr-host-");
    writeFileSync(join(outside, "host-secret.env"), `AWS_ACCESS_KEY_ID=${AWS}\n`);
    const ws = swapRepo(
      `import { rmSync, symlinkSync } from "node:fs";
rmSync(".brokkr/generated/a.md");
symlinkSync(${JSON.stringify(join(outside, "host-secret.env"))}, ".brokkr/generated/a.md");
`,
    );
    const report = await verifyReal(ws);
    expect(report.checks.find((c) => c.id === "test")?.state).toBe("passed");
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/\.brokkr\/generated\/a\.md.*symlink/);
  });

  it(
    "a check that plants a FIFO or a /dev/zero link does not hang verify",
    { timeout: 30_000 },
    async () => {
      const ws = swapRepo(
        `import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
execFileSync("mkfifo", [".brokkr/generated/pipe"]);
symlinkSync("/dev/zero", ".brokkr/generated/zero.md");
`,
      );
      const started = Date.now();
      const report = await verifyReal(ws);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(report.verdict).toBe("passed");
      expect(report.warnings.join("\n")).toMatch(/zero\.md.*symlink/);
      expect(report.warnings.join("\n")).toMatch(/pipe.*not a regular file/);
    },
  );

  it("a check that swaps a bundle file for a hard link to a host secret: never read (fix round 3, I-a)", async () => {
    const outside = tempDir("brokkr-host-");
    writeFileSync(join(outside, "host-secret.env"), `AWS_ACCESS_KEY_ID=${AWS}\n`);
    const ws = swapRepo(
      `import { linkSync, rmSync } from "node:fs";
rmSync(".brokkr/generated/a.md");
linkSync(${JSON.stringify(join(outside, "host-secret.env"))}, ".brokkr/generated/a.md");
`,
    );
    const report = await verifyReal(ws);
    expect(report.verdict).toBe("passed");
    expect(report.warnings.join("\n")).toMatch(/\.brokkr\/generated\/a\.md: it is a hard link/);
  });

  it("a check that writes a real secret into a bundle file still blocks", async () => {
    const ws = swapRepo(
      `import { writeFileSync } from "node:fs";
writeFileSync(".brokkr/generated/a.md", "key ${AWS}\\n");
`,
    );
    expect((await verifyReal(ws)).verdict).toBe("blocked");
  });
});
