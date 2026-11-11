import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedSpec, startFlow, type Flow } from "./flow.js";

// Generated harnesses go under the Brokkr home; the tests point it at a temp directory so
// nothing is written to (or read from) the real `~/.brokkr`.
let brokkrHome: string;
let previousHome: string | undefined;
let f: Flow;
beforeEach(async () => {
  brokkrHome = mkdtempSync(join(tmpdir(), "sindri-brokkr-home-"));
  previousHome = process.env["SINDRI_BROKKR_HOME"];
  process.env["SINDRI_BROKKR_HOME"] = brokkrHome;
  f = await startFlow();
});
afterEach(async () => {
  await f.close();
  if (previousHome === undefined) delete process.env["SINDRI_BROKKR_HOME"];
  else process.env["SINDRI_BROKKR_HOME"] = previousHome;
  rmSync(brokkrHome, { recursive: true, force: true });
});

const PROFILE = {
  checks: [
    { id: "lint", command: ["make", "lint"], cwd: "services/api", timeoutSeconds: 900 },
    { id: "test", title: "Unit tests", command: ["make", "test"], cwd: "services/api" },
  ],
  network: "allow",
  env: { GOCACHE: "/caches/build", GOMODCACHE: "/caches/mod" },
  pathPrepend: ["/opt/shims"],
  codexSandbox: { writableRoots: ["/caches"], networkAccess: false },
  verificationTimeoutMs: 1_800_000,
};

const url = (projectId = f.projectId) => `/v1/projects/${projectId}/profile`;
const put = (payload: unknown, projectId?: string) =>
  f.h.call({ method: "PUT", url: url(projectId), payload: payload as object });
const harnessFile = (name: string) =>
  join(brokkrHome, ".brokkr", "harnesses", name, "harness.json");

describe("execution profile", () => {
  it("is empty until set, then round-trips", async () => {
    const empty = await f.h.call({ url: url() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ profile: {} });

    const saved = await put(PROFILE);
    expect(saved.statusCode).toBe(200);
    const { profile, harness } = saved.json();
    expect(profile).toEqual(PROFILE);
    expect(harness).toEqual({
      name: expect.stringMatching(/^sindri-reports-[0-9a-f]{8}$/),
      version: "1.0.0",
    });
    expect((await f.h.call({ url: url() })).json()).toEqual({ profile: PROFILE });
    // The project's other fields are untouched.
    const project = (await f.h.call({ url: `/v1/projects/${f.projectId}` })).json().project;
    expect(project).toMatchObject({ name: "Reports", repoPath: f.repo.path });
  });

  it("writes the generated harness with the profile's checks, env names and network", async () => {
    const { harness } = (await put(PROFILE)).json();
    const manifest = JSON.parse(readFileSync(harnessFile(harness.name), "utf8"));
    expect(manifest.metadata).toMatchObject({ name: harness.name, version: "1.0.0" });
    expect(manifest.policies.network).toBe("allow");
    expect(manifest.checks).toEqual([
      {
        id: "lint",
        command: ["make", "lint"],
        required: true,
        timeoutSeconds: 900,
        cwd: "services/api",
        env: ["GOCACHE", "GOMODCACHE"],
      },
      {
        id: "test",
        command: ["make", "test"],
        required: true,
        timeoutSeconds: 600,
        cwd: "services/api",
        env: ["GOCACHE", "GOMODCACHE"],
      },
    ]);
  });

  it("gives different checks a different harness and keeps the earlier directory", async () => {
    const first = (await put(PROFILE)).json().harness;
    const before = readFileSync(harnessFile(first.name), "utf8");
    const second = (await put({ ...PROFILE, checks: [PROFILE.checks[1]] })).json().harness;
    expect(second.name).not.toBe(first.name);
    expect(existsSync(harnessFile(second.name))).toBe(true);
    expect(readFileSync(harnessFile(first.name), "utf8")).toBe(before);
    // The same content again is the same harness.
    expect((await put(PROFILE)).json().harness).toEqual(first);
  });

  it("has no harness without checks", async () => {
    const res = await put({ env: { GOFLAGS: "-mod=mod" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profile: { env: { GOFLAGS: "-mod=mod" } }, harness: null });
    const cleared = await put({});
    expect(cleared.json()).toEqual({ profile: {}, harness: null });
  });

  it("rejects invalid profiles with 422 and stores nothing", async () => {
    const bad: unknown[] = [
      { checks: [{ id: "a", command: "make lint" }] },
      { checks: [{ id: "a", command: ["make", ""] }] },
      { checks: [{ id: "a", command: ["make"], cwd: "../outside" }] },
      { checks: [{ id: "a", command: ["make"], cwd: "/abs" }] },
      { checks: [{ id: "a", command: ["make"], required: false }] },
      { env: { PATH: "/x" } },
      { env: { GIT_SSH_COMMAND: "x" } },
      { env: { LD_PRELOAD: "x" } },
      { env: { "NOT-A-NAME": "x" } },
      { pathPrepend: ["relative/bin"] },
      { codexSandbox: { writableRoots: ["caches"] } },
      { network: "sometimes" },
      { unknown: true },
    ];
    for (const payload of bad) {
      const res = await put(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json().error.code).toBe("validation_failed");
    }
    expect((await f.h.call({ url: url() })).json()).toEqual({ profile: {} });
    expect(existsSync(join(brokkrHome, ".brokkr"))).toBe(false);
  });

  it("needs the bearer token, an Idempotency-Key for writes, and a known project", async () => {
    const anonymous = await f.h.app.inject({ method: "GET", url: url() });
    expect(anonymous.statusCode).toBe(401);
    const unkeyed = await f.h.call({ method: "PUT", url: url(), payload: PROFILE, key: null });
    expect(unkeyed.statusCode).toBe(422);
    expect(unkeyed.json().error.code).toBe("idempotency_key_required");
    const noToken = await f.h.app.inject({
      method: "PUT",
      url: url(),
      headers: { "idempotency-key": "k-profile-anon" },
      payload: PROFILE,
    });
    expect(noToken.statusCode).toBe(401);
    expect((await f.h.call({ url: url("missing") })).statusCode).toBe(404);
    expect((await put(PROFILE, "missing")).statusCode).toBe(404);
  });
});

describe("planning with an execution profile (Brokkr)", () => {
  const enableBrokkr = async () => {
    const st = (await f.h.call({ url: "/v1/settings" })).json().settings;
    const res = await f.h.call({
      method: "PUT",
      url: "/v1/settings",
      payload: { ...st, brokkrEnabled: true },
    });
    expect(res.statusCode).toBe(200);
  };
  const propose = (specId: string) =>
    f.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
  type Task = {
    id: string;
    role: string;
    harnessId: string;
    harnessVersion: string;
    harnessLockDigest: string;
    harnessSelection: {
      harnesses: { name: string; checks: unknown[] }[];
      lock: { digest: string };
    };
  };

  it("gives every task of a profiled project the generated harness", async () => {
    await enableBrokkr();
    const { harness } = (await put(PROFILE)).json();
    const res = await propose(await approvedSpec(f));
    expect(res.statusCode).toBe(201);
    expect(res.json().harnessSource).toBe("brokkr");
    const tasks = res.json().plan.tasks as Task[];
    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks.map((t) => t.role)).toEqual(expect.arrayContaining(["docs"]));
    for (const t of tasks) {
      expect(t.harnessId, t.id).toBe(harness.name);
      expect(t.harnessVersion).toBe("1.0.0");
      expect(t.harnessSelection.harnesses.map((h) => h.name)).toEqual([harness.name]);
      expect(t.harnessSelection.harnesses[0]!.checks).toEqual([
        { id: "lint", required: true },
        { id: "test", required: true },
      ]);
      expect(t.harnessLockDigest).toBe(t.harnessSelection.lock.digest);
    }
  });

  it("plans an unprofiled project as before, even when another project has a harness", async () => {
    await enableBrokkr();
    // A second project with a profile shares the harness directory.
    const other = await f.h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Other", repoPath: f.h.repoDir },
    });
    expect(other.statusCode).toBe(201);
    const { harness } = (await put(PROFILE, other.json().project.id)).json();
    expect(harness.name).toMatch(/^sindri-other-/);

    const res = await propose(await approvedSpec(f));
    expect(res.statusCode).toBe(201);
    const tasks = res.json().plan.tasks as Task[];
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.harnessId, t.id).not.toMatch(/^sindri-/);
  });

  it("explains a selection for a profiled project with the generated harness", async () => {
    await enableBrokkr();
    const { harness } = (await put(PROFILE)).json();
    const res = await f.h.call({
      method: "POST",
      url: "/v1/harnesses/explain",
      payload: {
        projectId: f.projectId,
        task: { id: "t-1", title: "Docs", description: "Update docs", taskTypes: ["docs"] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().selection.harnesses.map((h: { name: string }) => h.name)).toEqual([
      harness.name,
    ]);
  });

  it("answers 422 with Brokkr's message when a requested harness cannot be resolved", async () => {
    await enableBrokkr();
    const res = await f.h.call({
      method: "POST",
      url: "/v1/harnesses/explain",
      payload: {
        task: { id: "t-1", title: "T", description: "d" },
        harnesses: [{ name: "backend-node", version: "^99.0.0" }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("backend-node");
  });
});
