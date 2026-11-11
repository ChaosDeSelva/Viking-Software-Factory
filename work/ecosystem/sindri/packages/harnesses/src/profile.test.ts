import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brokkr } from "@brokkr/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrokkrHarnessService,
  ensureProfileHarness,
  ExecutionProfileSchema,
  HarnessServiceError,
  profileHarnessManifest,
  type ExecutionProfile,
} from "./index.js";

const GO: ExecutionProfile = {
  checks: [
    { id: "lint", command: ["make", "lint"], cwd: "services/api", timeoutSeconds: 900 },
    { id: "test", title: "Unit tests", command: ["make", "test"], cwd: "services/api" },
    { id: "vet", command: ["go", "vet", "./..."], required: false },
  ],
  network: "allow",
  env: { GOMODCACHE: "/caches/mod", GOCACHE: "/caches/build" },
  pathPrepend: ["/opt/shims"],
  codexSandbox: { writableRoots: ["/caches"], networkAccess: false },
  verificationTimeoutMs: 1_800_000,
};

const invalid = (profile: unknown) => ExecutionProfileSchema.safeParse(profile).success === false;

describe("ExecutionProfileSchema", () => {
  it("accepts an empty profile and a full one", () => {
    expect(ExecutionProfileSchema.parse({})).toEqual({});
    expect(ExecutionProfileSchema.parse(GO)).toEqual(GO);
  });

  it("rejects unknown keys", () => {
    expect(invalid({ shell: "bash" })).toBe(true);
    expect(invalid({ checks: [{ id: "a", command: ["x"], shell: true }] })).toBe(true);
  });

  it("requires argv arrays of non-empty strings, capped in size", () => {
    const check = (command: unknown) => ({ checks: [{ id: "a", command }] });
    expect(invalid(check("make lint"))).toBe(true);
    expect(invalid(check([]))).toBe(true);
    expect(invalid(check(["make", ""]))).toBe(true);
    expect(invalid(check(Array.from({ length: 65 }, () => "x")))).toBe(true);
    expect(
      invalid({ checks: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, command: ["x"] })) }),
    ).toBe(true);
  });

  it("keeps cwd relative and inside the repository", () => {
    for (const cwd of ["/abs", "..", "../x", "a/../../x", "a\\b", ""])
      expect(invalid({ checks: [{ id: "a", command: ["x"], cwd }] }), cwd).toBe(true);
    expect(invalid({ checks: [{ id: "a", command: ["x"], cwd: "src/a/../b" }] })).toBe(false);
  });

  it("rejects duplicate check ids, bad ids and a profile without a required check", () => {
    expect(
      invalid({
        checks: [
          { id: "a", command: ["x"] },
          { id: "a", command: ["y"] },
        ],
      }),
    ).toBe(true);
    expect(invalid({ checks: [{ id: "Bad Id", command: ["x"] }] })).toBe(true);
    expect(invalid({ checks: [{ id: "a", command: ["x"], required: false }] })).toBe(true);
  });

  it("rejects environment names that are malformed or change how programs load code", () => {
    for (const name of [
      "1X",
      "A-B",
      "PATH",
      "HOME",
      "GIT_DIR",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "MIMIR_TOKEN",
    ])
      expect(invalid({ env: { [name]: "v" } }), name).toBe(true);
    expect(invalid({ env: { GOFLAGS: "-mod=mod", _X1: "" } })).toBe(false);
  });

  it("requires absolute paths for pathPrepend and writableRoots", () => {
    for (const p of ["bin", "./bin", "/", "/a:/b", "/a/../b"]) {
      expect(invalid({ pathPrepend: [p] }), p).toBe(true);
      expect(invalid({ codexSandbox: { writableRoots: [p] } }), p).toBe(true);
    }
  });

  it("bounds timeouts", () => {
    expect(invalid({ verificationTimeoutMs: 999 })).toBe(true);
    expect(invalid({ verificationTimeoutMs: 86_400_001 })).toBe(true);
    expect(invalid({ checks: [{ id: "a", command: ["x"], timeoutSeconds: 1.5 }] })).toBe(true);
  });
});

describe("profile harness", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sindri-brokkr-home-"));
    root = join(home, ".brokkr", "harnesses");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("has no harness without checks", () => {
    expect(profileHarnessManifest("P", {})).toBeNull();
    expect(ensureProfileHarness(root, "P", { env: { A: "b" } })).toBeNull();
    expect(existsSync(root)).toBe(false);
  });

  it("carries checks, cwd, timeouts, env names and network into the manifest", () => {
    const built = profileHarnessManifest("Services API!", GO)!;
    expect(built.name).toMatch(/^sindri-services-api-[0-9a-f]{8}$/);
    const m = built.manifest as {
      checks: unknown[];
      policies: { network: string };
      compatibility: { taskTypes: string[] };
    };
    expect(m.checks).toEqual([
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
      {
        id: "vet",
        command: ["go", "vet", "./..."],
        required: false,
        timeoutSeconds: 600,
        env: ["GOCACHE", "GOMODCACHE"],
      },
    ]);
    expect(m.policies.network).toBe("allow");
    expect(profileHarnessManifest("P", { checks: GO.checks! })!.manifest).toMatchObject({
      policies: { network: "deny" },
    });
    expect(m.compatibility.taskTypes).toEqual([]);
    // Values are not part of the harness: only names are.
    expect(JSON.stringify(m)).not.toContain("/caches");
  });

  it("names the harness after its content", () => {
    const a = profileHarnessManifest("P", GO)!.name;
    expect(profileHarnessManifest("P", { ...GO })!.name).toBe(a);
    // Things the harness does not contain do not change it.
    expect(
      profileHarnessManifest("P", {
        ...GO,
        env: { GOCACHE: "/x", GOMODCACHE: "/y" },
        pathPrepend: [],
      })!.name,
    ).toBe(a);
    expect(profileHarnessManifest("P", { ...GO, network: "deny" })!.name).not.toBe(a);
    expect(profileHarnessManifest("P", { ...GO, checks: GO.checks!.slice(0, 2) })!.name).not.toBe(
      a,
    );
    expect(profileHarnessManifest("x".repeat(200), GO)!.name.length).toBeLessThanOrEqual(64);
    expect(profileHarnessManifest("!!!", GO)!.name).toMatch(/^sindri-project-[0-9a-f]{8}$/);
  });

  it("writes one directory per distinct content and leaves earlier ones in place", () => {
    const first = ensureProfileHarness(root, "P", GO)!;
    const file = join(root, first.name, "harness.json");
    const before = readFileSync(file, "utf8");
    expect(ensureProfileHarness(root, "P", GO)).toEqual(first);
    expect(readFileSync(file, "utf8")).toBe(before);
    const second = ensureProfileHarness(root, "P", { ...GO, network: "deny" })!;
    expect(second.name).not.toBe(first.name);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(root, second.name, "harness.json"))).toBe(true);
  });

  it("resolves through Brokkr as the default contract for any task type", async () => {
    const ref = ensureProfileHarness(root, "P", GO)!;
    const svc = new BrokkrHarnessService({ cwd: home, homeDir: home, harnesses: [ref] });
    for (const taskTypes of [["backend"], ["docs"]]) {
      const sel = await svc.resolve({ task: { id: "t", title: "t", description: "d", taskTypes } });
      expect(sel.harnesses.map((h) => `${h.name}@${h.version}`)).toEqual([`${ref.name}@1.0.0`]);
      expect(sel.harnesses[0]!.checks).toEqual([
        { id: "lint", required: true },
        { id: "test", required: true },
        { id: "vet", required: false },
      ]);
    }
    // Without the contract the service chooses by task type: never this harness.
    const plain = new BrokkrHarnessService({ cwd: home, homeDir: home });
    const sel = await plain.resolve({
      task: { id: "t", title: "t", description: "d", taskTypes: ["docs"] },
    });
    expect(sel.harnesses.map((h) => h.name)).not.toContain(ref.name);
  }, 60_000);

  it("reports a Brokkr resolve failure as a HarnessServiceError with Brokkr's message", async () => {
    const svc = new BrokkrHarnessService({ cwd: home, homeDir: home });
    const err = await svc
      .resolve({
        task: { id: "t", title: "t", description: "d" },
        harnesses: [{ name: "sindri-missing-00000000", version: "1.0.0" }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessServiceError);
    expect((err as Error).message).toContain("sindri-missing-00000000");
  });

  // What Mimir's BrokkrVerifier does with a plan task's selection: a workspace-untrusted Brokkr
  // over the worktree, pinned to the planned lock, with its own run root and signing key.
  it("verifies a worktree with the generated harness, in cwd and with the listed variables", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sindri-profile-repo-"));
    const runs = mkdtempSync(join(tmpdir(), "sindri-profile-runs-"));
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      writeFileSync(
        join(repo, "src/app/Makefile"),
        'probe:\n\ttest -f Makefile && test "$$PROFILE_VALUE" = yes\n',
      );
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
      const ref = ensureProfileHarness(root, "P", {
        checks: [{ id: "probe", command: ["make", "probe"], cwd: "src/app", timeoutSeconds: 60 }],
        env: { PROFILE_VALUE: "unused-here" },
      })!;
      const planned = await new BrokkrHarnessService({
        cwd: repo,
        homeDir: home,
        harnesses: [ref],
      }).resolve({
        task: { id: "t", title: "t", description: "d", taskTypes: ["backend"] },
      });
      const brokkr = new Brokkr({
        cwd: repo,
        trust: "workspace-untrusted",
        harnesses: [ref],
        offline: true,
        lock: planned.lock as never,
        homeDir: home,
        runRoot: runs,
        signingKey: Buffer.alloc(32, 7),
        approvers: [],
        exceptions: [],
      });
      const task = { id: "task-1", title: "t", description: "d" };
      const selection = await brokkr.resolve({ task, harnesses: [ref] });
      const run = (env: Record<string, string>) =>
        brokkr.verify({
          selection,
          workspace: repo,
          task,
          env: { PATH: process.env["PATH"], ...env },
        });
      const passed = await run({ PROFILE_VALUE: "yes" });
      expect(passed.checks.map((c) => [c.id, c.state])).toEqual([["probe", "passed"]]);
      expect(passed.verdict).toBe("passed");
      expect((await run({})).verdict).toBe("failed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  }, 60_000);
});
