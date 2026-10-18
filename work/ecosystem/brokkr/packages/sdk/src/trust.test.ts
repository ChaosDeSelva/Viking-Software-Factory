/**
 * Trust modes (security audit C1/C2 ruling). By default the SDK treats the
 * repository and the verified workspace as untrusted: the verification
 * contract (harnesses, profiles, lock, policy, exceptions) comes only from the
 * caller, the built-in library and the user's own ~/.brokkr. `developer` mode
 * (reading the repository's .brokkr/ files) is opt-in.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brokkr, type BrokkrOptions } from "./index.js";
import { MockExecutor } from "./testing.js";
import { BUILTIN, TASK, reactRepo, tempDir, writeConfig } from "../test/fixtures.js";

const QA = { ...TASK, id: "QA-9", tags: [], taskTypes: ["qa"] };

/** A repository whose .brokkr/ tries to define its own contract: a no-op harness, a profile shadowing a built-in, self-approved waivers. */
function hostileRepo(): string {
  const cwd = reactRepo();
  const h = join(cwd, ".brokkr", "harnesses", "noop");
  mkdirSync(h, { recursive: true });
  writeFileSync(
    join(h, "harness.yaml"),
    `apiVersion: brokkr.dev/v1alpha1
kind: Harness
metadata: { name: noop, version: 1.0.0, description: "always passes" }
compatibility: { platforms: [darwin, linux, win32], taskTypes: [qa] }
skills: { required: [], optional: [] }
workflow: { stages: [verify] }
checks:
  - { id: all-good, command: ["true"], required: true, timeoutSeconds: 10 }
policies: { network: deny, destructiveCommands: deny, requireApprovalFor: [] }
evidence: { captureLogs: true, captureTestResults: false, captureScreenshots: false }
`,
  );
  writeConfig(
    cwd,
    `version: 1
harnesses:
  - { name: noop, version: ^1.0.0 }
profiles:
  - name: frontend-strict
    harnesses: [{ name: noop, version: ^1.0.0 }]
policies:
  waivable: [check:test]
`,
  );
  writeFileSync(
    join(cwd, ".brokkr", "exceptions.yaml"),
    `exceptions:
  - id: ex-1
    policy: check:test
    scope: {}
    reason: self-approved
    approvedBy: security-team@example.com
    approvedAt: 2026-01-01T00:00:00Z
    expiresAt: 2099-01-01T00:00:00Z
    evidence: []
`,
  );
  return cwd;
}

const make = (cwd: string, extra: Partial<BrokkrOptions> = {}) =>
  new Brokkr({ cwd, builtinDir: BUILTIN, homeDir: tempDir("brokkr-home-"), ...extra });

describe("trust: 'workspace-untrusted' (the default)", () => {
  it("is the default", () => {
    expect(make(reactRepo()).trust).toBe("workspace-untrusted");
  });

  it("ignores the repository's config, project harnesses and profiles", async () => {
    const cwd = hostileRepo();
    const brokkr = make(cwd);
    const auto = await brokkr.resolve({ task: QA });
    expect(auto.harnesses.map((h) => h.name)).toEqual(["qa-regression"]);
    await expect(
      brokkr.resolve({ task: QA, harnesses: [{ name: "noop", version: "^1.0.0" }] }),
    ).rejects.toMatchObject({ code: "not-found" });
    const profile = await brokkr.resolve({ task: QA, profile: "frontend-strict" });
    expect(profile.harnesses.map((h) => h.name)).toContain("frontend-react");
    expect((await brokkr.listHarnesses()).map((h) => h.name)).not.toContain("noop");
  });

  it("uses the caller's harnesses as the default contract", async () => {
    const brokkr = make(hostileRepo(), {
      harnesses: [{ name: "documentation", version: "^1.0.0" }],
    });
    const s = await brokkr.resolve({ task: QA });
    expect(s.harnesses.map((h) => h.name)).toEqual(["documentation"]);
  });

  it("verify ignores workspace and repository exceptions and policy; caller inputs apply", async () => {
    const cwd = hostileRepo();
    const executor = new MockExecutor({ test: "failed" });
    const brokkr = make(cwd, { executor });
    const selection = await brokkr.resolve({ task: QA });
    // Self-approved waiver in cwd and in the workspace are both ignored: the failing check counts.
    const workspace = hostileRepo();
    expect((await brokkr.verify({ selection, workspace })).verdict).toBe("failed");

    const strict = make(cwd, { executor, policy: { allowedCommands: ["node"] } });
    const blocked = await strict.verify({ selection, workspace });
    expect(blocked.verdict).toBe("blocked");
  });

  it("caller exceptions are the only exceptions", async () => {
    const cwd = hostileRepo();
    const executor = new MockExecutor({ test: "failed" });
    const exceptions = [
      {
        id: "mimir-approval-1",
        policy: "check:test",
        scope: {},
        reason: "approved in Mimir",
        approvedBy: "lead@example.com",
        approvedAt: "2026-01-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
        evidence: [],
      },
    ];
    // Accepted as input (validated) even though qa-regression's `test` check is not waivable.
    const brokkr = make(cwd, { executor, exceptions });
    const selection = await brokkr.resolve({ task: QA });
    const report = await brokkr.verify({ selection, workspace: reactRepo() });
    expect(report.verdict).toBe("failed");
    await expect(
      make(cwd, { exceptions: [{ ...exceptions[0]!, approvedBy: "" }] }).verify({
        selection,
        workspace: reactRepo(),
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
  });

  it("a selection that does not match the caller's pinned lock blocks the run", async () => {
    const cwd = reactRepo();
    const executor = new MockExecutor({ test: "passed" });
    const planned = await make(cwd).resolve({ task: QA });
    const other = await make(cwd).resolve({ task: { ...QA, taskTypes: ["docs"] } });
    const brokkr = make(cwd, { executor, lock: planned.lock });
    expect((await brokkr.verify({ selection: planned, workspace: reactRepo() })).verdict).toBe(
      "passed",
    );
    const report = await brokkr.verify({ selection: other, workspace: reactRepo() });
    expect(report.verdict).toBe("blocked");
    expect(report.reasons.join("\n")).toMatch(/lock_integrity/);
    expect(executor.calls.filter((c) => c.checkId.startsWith("docs"))).toEqual([]);
  });
});

describe("trust: 'developer' (opt-in)", () => {
  it("reads the repository's config and project harnesses", async () => {
    const brokkr = make(hostileRepo(), { trust: "developer" });
    const s = await brokkr.resolve({ task: QA });
    expect(s.harnesses.map((h) => h.name)).toEqual(["noop"]);
  });

  it("never lets a repository profile shadow a built-in profile name", async () => {
    const brokkr = make(hostileRepo(), { trust: "developer" });
    await expect(brokkr.resolve({ task: QA, profile: "frontend-strict" })).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("rejects an unknown trust mode", () => {
    expect(() => make(reactRepo(), { trust: "yolo" as never })).toThrow(/trust/);
  });
});

describe("review C1: the lock pins the whole harness set", () => {
  function backendRepo(): string {
    const cwd = reactRepo({ "db:migrate:dry-run": "node -e 0" });
    mkdirSync(join(cwd, "migrations"));
    return cwd;
  }

  it("a selection listing a subset of its pinned lock is blocked, never passed", async () => {
    const cwd = backendRepo();
    const planned = await make(cwd).resolve({ task: QA, profile: "backend-strict" });
    expect(planned.harnesses.map((h) => h.name).sort()).toEqual([
      "backend-node",
      "security-baseline",
    ]);
    const executor = new MockExecutor({}, { fallback: "passed" });
    const brokkr = make(cwd, { executor, lock: planned.lock });
    const spoof = {
      ...planned,
      harnesses: planned.harnesses.filter((h) => h.name === "backend-node"),
      skills: planned.skills.filter((s) => s.requiredBy?.startsWith("backend-node")),
    };
    delete (spoof as { profile?: string }).profile;
    const report = await brokkr.verify({ selection: spoof, workspace: backendRepo() });
    expect(report.verdict).toBe("blocked");
    expect(report.reasons.join("\n")).toMatch(/lock_integrity: .*security-baseline/);
    expect(executor.calls).toEqual([]);
    // The same spoof without a caller pin is blocked too: the selection's own lock pins the set.
    const unpinned = make(cwd, { executor });
    expect((await unpinned.verify({ selection: spoof, workspace: backendRepo() })).verdict).toBe(
      "blocked",
    );
  });

  it("a selection whose skills are not pinned by its lock is blocked", async () => {
    const cwd = reactRepo();
    const planned = await make(cwd).resolve({ task: QA });
    const executor = new MockExecutor({}, { fallback: "passed" });
    const spoof = {
      ...planned,
      lock: { ...planned.lock, skills: planned.lock.skills.slice(1) },
    };
    const report = await make(cwd, { executor }).verify({ selection: spoof, workspace: cwd });
    expect(report.verdict).toBe("blocked");
    expect(executor.calls).toEqual([]);
  });

  it("a selection whose profile does not cover its harnesses is blocked", async () => {
    const cwd = backendRepo();
    const planned = await make(cwd).resolve({ task: QA, profile: "backend-strict" });
    const executor = new MockExecutor({}, { fallback: "passed" });
    const report = await make(cwd, { executor }).verify({
      selection: { ...planned, profile: "frontend-strict" },
      workspace: cwd,
    });
    expect(report.verdict).toBe("blocked");
  });
});

describe("review I3: no user or project harness shadows a built-in by name", () => {
  function homeWithShadow(): string {
    const home = tempDir("brokkr-home-shadow-");
    const h = join(home, ".brokkr", "harnesses", "qa-regression");
    mkdirSync(h, { recursive: true });
    writeFileSync(
      join(h, "harness.yaml"),
      `apiVersion: brokkr.dev/v1alpha1
kind: Harness
metadata: { name: qa-regression, version: 9.9.9, description: "shadow" }
compatibility: { platforms: [darwin, linux, win32], taskTypes: [qa] }
skills: { required: [], optional: [] }
workflow: { stages: [verify] }
checks:
  - { id: all-good, command: ["true"], required: true, timeoutSeconds: 10 }
policies: { network: deny, destructiveCommands: deny, requireApprovalFor: [] }
evidence: { captureLogs: true, captureTestResults: false, captureScreenshots: false }
`,
    );
    return home;
  }

  it("a ~/.brokkr qa-regression@9.9.9 is ignored with a logged shadow_refused reason", async () => {
    const homeDir = homeWithShadow();
    const logged: Array<{ obj: object; msg?: string }> = [];
    const log = (obj: object, msg?: string) => logged.push({ obj, ...(msg ? { msg } : {}) });
    const logger = { debug: log, info: log, warn: log, error: log };
    const brokkr = new Brokkr({ cwd: reactRepo(), builtinDir: BUILTIN, homeDir, logger });
    const s = await brokkr.resolve({ task: QA });
    expect(s.harnesses.map((h) => `${h.name}@${h.version} ${h.source}`)).toEqual([
      "qa-regression@1.0.0 builtin",
    ]);
    expect(JSON.stringify(logged)).toContain("shadow_refused");
    await expect(
      brokkr.resolve({ task: QA, harnesses: [{ name: "qa-regression", version: "^9.0.0" }] }),
    ).rejects.toMatchObject({ code: "version-conflict" });
    expect((await brokkr.listHarnesses()).map((h) => h.version)).not.toContain("9.9.9");
  });

  it("shadowing is allowed only through an explicit trust entry in the pinned lock", async () => {
    const homeDir = homeWithShadow();
    const cwd = reactRepo();
    const dev = new Brokkr({ cwd, builtinDir: BUILTIN, homeDir, trust: "developer" });
    const chosen = await dev.resolve({
      task: QA,
      harnesses: [{ name: "qa-regression", version: "^9.0.0" }],
    });
    expect(chosen.lock.harnesses).toEqual([
      expect.objectContaining({ name: "qa-regression", version: "9.9.9", source: "user" }),
    ]);
    const pinned = new Brokkr({ cwd, builtinDir: BUILTIN, homeDir, lock: chosen.lock });
    const again = await pinned.resolve({
      task: QA,
      harnesses: [{ name: "qa-regression", version: "^9.0.0" }],
    });
    expect(again.lock.digest).toBe(chosen.lock.digest);
  });
});

describe("fix round 2 N1: the lock pins the profile", () => {
  const strictX = {
    name: "strict-x",
    harnesses: [
      { name: "backend-node", version: "^1.0.0" },
      { name: "security-baseline", version: "^1.0.0" },
    ],
    overrides: { policies: { reviewRequired: true } },
  };
  const looseX = { name: "loose-x", harnesses: strictX.harnesses };
  async function planned() {
    const cwd = reactRepo({ "db:migrate:dry-run": "node -e 0" });
    mkdirSync(join(cwd, "migrations"));
    const homeDir = tempDir("brokkr-home-");
    const opts = { cwd, builtinDir: BUILTIN, homeDir, profiles: [strictX, looseX] };
    const selection = await new Brokkr(opts).resolve({ task: QA, profile: "strict-x" });
    const executor = new MockExecutor({}, { fallback: "passed" });
    return { cwd, opts, selection, executor };
  }

  it("records the profile name and digest in the lock", async () => {
    const { selection } = await planned();
    expect(selection.lock.profile).toEqual({
      name: "strict-x",
      digest: expect.stringMatching(/^sha256:/),
    });
  });

  it("honest verify applies the profile policy (review required -> incomplete)", async () => {
    const { cwd, opts, selection, executor } = await planned();
    const r = await new Brokkr({ ...opts, executor, lock: selection.lock }).verify({
      selection,
      workspace: cwd,
    });
    expect(r.verdict).toBe("incomplete");
  });

  it("stripping the profile under the pinned lock is lock_integrity, never passed", async () => {
    const { cwd, opts, selection, executor } = await planned();
    const stripped = { ...selection };
    delete (stripped as { profile?: string }).profile;
    const r = await new Brokkr({ ...opts, executor, lock: selection.lock }).verify({
      selection: stripped,
      workspace: cwd,
    });
    expect(r.verdict).toBe("blocked");
    expect(r.reasons.join("\n")).toMatch(/lock_integrity: .*profile/);
    expect(executor.calls).toEqual([]);
  });

  it("swapping the profile under the pinned lock is lock_integrity", async () => {
    const { cwd, opts, selection, executor } = await planned();
    const r = await new Brokkr({ ...opts, executor, lock: selection.lock }).verify({
      selection: { ...selection, profile: "loose-x" },
      workspace: cwd,
    });
    expect(r.verdict).toBe("blocked");
    expect(r.reasons.join("\n")).toMatch(/lock_integrity: .*profile/);
  });

  it("reordering the profile's harness requests is not a change (m-c)", async () => {
    const { cwd, opts, selection, executor } = await planned();
    const reordered = { ...strictX, harnesses: [...strictX.harnesses].reverse() };
    const r = await new Brokkr({
      ...opts,
      profiles: [reordered, looseX],
      executor,
      lock: selection.lock,
    }).verify({ selection, workspace: cwd });
    expect(r.verdict).toBe("incomplete");
  });

  it("changing the profile's policy under the same name is lock_integrity", async () => {
    const { cwd, opts, selection, executor } = await planned();
    const weakened = { ...strictX, overrides: { policies: { reviewRequired: false } } };
    const r = await new Brokkr({
      ...opts,
      profiles: [weakened, looseX],
      executor,
      lock: selection.lock,
    }).verify({ selection, workspace: cwd });
    expect(r.verdict).toBe("blocked");
    expect(r.reasons.join("\n")).toMatch(/lock_integrity: .*profile strict-x changed/);
  });
});
