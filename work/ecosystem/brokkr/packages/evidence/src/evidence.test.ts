import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  readdirSync,
  realpathSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerificationReportSchema, type VerificationReport } from "@brokkr/core";
import {
  EVIDENCE_MANIFEST,
  createRun,
  createRunId,
  finalizeRun,
  latestRun,
  listRuns,
  pruneRuns,
  readReport,
  repositoryState,
  runsRootFor,
  signingKey,
} from "./index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "brokkr-evidence-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

function gitRepo(): string {
  const dir = tmp();
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function baseReport(id: string, over: Partial<VerificationReport> = {}): VerificationReport {
  return VerificationReportSchema.parse({
    schemaVersion: "1.0",
    id,
    harness: { name: "h", version: "1.0.0", lockDigest: `sha256:${"a".repeat(64)}` },
    harnesses: [],
    repository: { commitSha: "abc" },
    startedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:01.000Z",
    verdict: "passed",
    reasons: [],
    checks: [
      {
        id: "tests",
        required: true,
        state: "passed",
        command: ["node", "--test"],
        cwd: ".",
        from: ["h@1.0.0"],
        durationMs: 5,
        log: "logs/tests.log",
      },
    ],
    policyDecisions: [],
    exceptions: [],
    evidence: [],
    summary: { passed: 1, failed: 0, skipped: 0, errored: 0 },
    environment: { brokkrVersion: "0.1.0", node: "v25", platform: "darwin", arch: "arm64" },
    warnings: [],
    ...over,
  });
}

describe("createRunId", () => {
  it("is run_<ULID> and sorts by creation time", () => {
    const a = createRunId(new Date("2026-01-01T00:00:00Z"));
    const b = createRunId(new Date("2026-01-01T00:00:01Z"));
    expect(a).toMatch(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(createRunId()).not.toBe(createRunId());
  });
});

describe("createRun", () => {
  it("stores runs outside the workspace, under <home>/.brokkr/runs/<sha256(workspace)>", async () => {
    const ws = tmp();
    const home = tmp();
    const run = await createRun(ws, { home });
    const root = runsRootFor(ws, home);
    expect(root).toBe(
      join(home, ".brokkr", "runs", createHash("sha256").update(realpathSync(ws)).digest("hex")),
    );
    expect(run.dir).toBe(join(root, run.id));
    expect(existsSync(join(ws, ".brokkr"))).toBe(false);
    for (const sub of ["logs", "screenshots", "test-results"])
      expect(existsSync(join(run.dir, sub))).toBe(true);
    expect(run.logPath("typecheck")).toBe(join(run.dir, "logs", "typecheck.log"));
  });

  it("refuses a symlinked runs directory (audit I6)", async () => {
    const ws = tmp();
    const home = tmp();
    const outside = tmp();
    mkdirSync(join(home, ".brokkr"));
    symlinkSync(outside, join(home, ".brokkr", "runs"));
    await expect(createRun(ws, { home })).rejects.toMatchObject({ code: "policy-denied" });
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("signing key (audit I2)", () => {
  it("is created once with mode 0600 and reused", async () => {
    const home = tmp();
    const a = await signingKey(home);
    const b = await signingKey(home);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(statSync(join(home, ".brokkr", "key")).mode & 0o777).toBe(0o600);
  });

  it("refuses a key readable by others or a symlinked key", async () => {
    const home = tmp();
    await signingKey(home);
    chmodSync(join(home, ".brokkr", "key"), 0o644);
    await expect(signingKey(home)).rejects.toMatchObject({ code: "policy-denied" });
    const other = tmp();
    mkdirSync(join(other, ".brokkr"));
    symlinkSync(join(home, ".brokkr", "key"), join(other, ".brokkr", "key"));
    await expect(signingKey(other)).rejects.toMatchObject({ code: "policy-denied" });
  });
});

describe("repositoryState", () => {
  it("records HEAD and a digest that changes with the working tree", async () => {
    const repo = gitRepo();
    const clean = await repositoryState(repo);
    expect(clean.commitSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(clean.dirtyTreeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    writeFileSync(join(repo, "a.txt"), "two\n");
    const modified = await repositoryState(repo);
    expect(modified.dirtyTreeDigest).not.toBe(clean.dirtyTreeDigest);

    writeFileSync(join(repo, "a.txt"), "three\n");
    const modifiedAgain = await repositoryState(repo);
    expect(modifiedAgain.dirtyTreeDigest).not.toBe(modified.dirtyTreeDigest);

    writeFileSync(join(repo, "new.txt"), "x\n");
    const untracked = await repositoryState(repo);
    writeFileSync(join(repo, "new.txt"), "y\n");
    const untrackedChanged = await repositoryState(repo);
    expect(untrackedChanged.dirtyTreeDigest).not.toBe(untracked.dirtyTreeDigest);
  }, 30_000);

  it("ignores only .git and the verified source cache", { timeout: 30_000 }, async () => {
    const repo = gitRepo();
    const before = await repositoryState(repo);
    mkdirSync(join(repo, ".brokkr", "cache", "sources", "x"), { recursive: true });
    writeFileSync(join(repo, ".brokkr", "cache", "sources", "x", "f"), "z");
    expect((await repositoryState(repo)).dirtyTreeDigest).toBe(before.dirtyTreeDigest);
  });

  it("marks non-git workspaces as unversioned with a warning (the tree digest still applies)", async () => {
    const state = await repositoryState(tmp());
    expect(state.commitSha).toBe("unversioned");
    expect(state.dirtyTreeDigest).toMatch(/^sha256:/);
    expect(state.warnings.join()).toMatch(/not a git repository/);
  });

  it("handles a repository without commits", async () => {
    const dir = tmp();
    git(dir, "init", "-q");
    writeFileSync(join(dir, "f.txt"), "x");
    const state = await repositoryState(dir);
    expect(state.commitSha).toBe("unborn");
    expect(state.dirtyTreeDigest).toMatch(/^sha256:/);
  });
});

describe("finalizeRun and readReport", () => {
  async function finished() {
    const ws = tmp();
    const run = await createRun(ws);
    writeFileSync(run.logPath("tests"), "ok 1 - works\n");
    mkdirSync(join(run.dir, "test-results", "tests"), { recursive: true });
    writeFileSync(join(run.dir, "test-results", "tests", "junit.xml"), "<testsuite/>");
    mkdirSync(join(run.dir, "screenshots", "visual"), { recursive: true });
    writeFileSync(join(run.dir, "screenshots", "visual", "home.png"), "PNG");
    symlinkSync("/etc/hosts", join(run.dir, "test-results", "tests", "link"));
    const report = await finalizeRun(run.dir, baseReport(run.id), {
      workspace: ws,
      markdown: (r) => `# ${r.verdict}\n`,
    });
    return { ws, run, report };
  }

  it("writes report.json, report.md and a hashed evidence manifest", async () => {
    const { run, report } = await finished();
    expect(existsSync(join(run.dir, "report.json"))).toBe(true);
    expect(readFileSync(join(run.dir, "report.md"), "utf8")).toBe("# passed\n");
    const manifest = JSON.parse(readFileSync(join(run.dir, EVIDENCE_MANIFEST), "utf8"));
    const paths = manifest.artifacts.map((a: { path: string }) => a.path).sort();
    expect(paths).toEqual([
      "logs/tests.log",
      "report.json",
      "report.md",
      "screenshots/visual/home.png",
      "test-results/tests/junit.xml",
    ]);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "logs/tests.log",
          producedBy: "tests",
          kind: "log",
          bytes: 13,
        }),
        expect.objectContaining({ path: "test-results/tests/junit.xml", kind: "test-result" }),
        expect.objectContaining({
          path: "screenshots/visual/home.png",
          producedBy: "visual",
          kind: "screenshot",
        }),
      ]),
    );
    for (const e of report.evidence) expect(e.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("readReport verifies integrity of every artifact", async () => {
    const { run } = await finished();
    const ok = await readReport(run.dir);
    expect(ok.integrity).toEqual({ status: "ok", problems: [] });
    expect(ok.report.verdict).toBe("passed");

    writeFileSync(run.logPath("tests"), "ok 1 - works (edited)\n");
    const bad = await readReport(run.dir);
    expect(bad.integrity.status).toBe("integrity_failed");
    expect(bad.integrity.problems.join()).toMatch(/logs\/tests.log.*digest mismatch/);
    await expect(readReport(run.dir, { strict: true })).rejects.toMatchObject({
      code: "integrity",
    });
  });

  it("detects an edited report.json and missing artifacts", async () => {
    const { run } = await finished();
    const path = join(run.dir, "report.json");
    writeFileSync(path, readFileSync(path, "utf8").replace('"passed"', '"failed"'));
    const edited = await readReport(run.dir);
    expect(edited.integrity.problems.join()).toMatch(/report.json.*digest mismatch/);

    const { run: run2 } = await finished();
    execFileSync("rm", [join(run2.dir, "screenshots", "visual", "home.png")]);
    expect((await readReport(run2.dir)).integrity.problems.join()).toMatch(/home.png.*missing/);
  });

  it("flags a missing manifest", async () => {
    const { run } = await finished();
    execFileSync("rm", [join(run.dir, EVIDENCE_MANIFEST)]);
    const result = await readReport(run.dir);
    expect(result.integrity.status).toBe("integrity_failed");
    expect(result.integrity.problems.join()).toMatch(/manifest/);
  });

  it("rejects an unsigned run", async () => {
    const { run } = await finished();
    const path = join(run.dir, EVIDENCE_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    delete manifest.signature;
    writeFileSync(path, JSON.stringify(manifest));
    const result = await readReport(run.dir);
    expect(result.integrity.status).toBe("integrity_failed");
    expect(result.integrity.problems.join()).toMatch(/unsigned/);
  });

  it("rejects a forged run whose manifest digests were recomputed without the key", async () => {
    const { run } = await finished();
    const reportPath = join(run.dir, "report.json");
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace('"passed"', '"failed"'));
    const path = join(run.dir, EVIDENCE_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const a of manifest.artifacts)
      a.sha256 = `sha256:${createHash("sha256")
        .update(readFileSync(join(run.dir, a.path)))
        .digest("hex")}`;
    writeFileSync(path, JSON.stringify(manifest));
    const result = await readReport(run.dir);
    expect(result.integrity.status).toBe("integrity_failed");
    expect(result.integrity.problems.join()).toMatch(/signature mismatch/);
  });

  it("rejects a run signed with another installation's key", async () => {
    const { run } = await finished();
    const result = await readReport(run.dir, { home: tmp() });
    expect(result.integrity.problems.join()).toMatch(/signature mismatch/);
  });

  it("rejects a run id dated in the future", async () => {
    const ws = tmp();
    const id = createRunId(new Date(Date.now() + 86_400_000));
    const run = await createRun(ws, { runId: id });
    await finalizeRun(run.dir, baseReport(id), { workspace: ws });
    const result = await readReport(run.dir);
    expect(result.integrity.problems.join()).toMatch(/dated in the future/);
  });

  it("throws invalid-config for a directory without report.json", async () => {
    await expect(readReport(tmp())).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("listRuns, latestRun and pruneRuns", () => {
  async function workspaceWithRuns(n: number) {
    const ws = tmp();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = createRunId(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      const run = await createRun(ws, { runId: id });
      await finalizeRun(
        run.dir,
        baseReport(id, {
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
        { workspace: ws },
      );
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(run.dir, t, t);
      ids.push(id);
    }
    mkdirSync(join(runsRootFor(ws), "not-a-run"));
    return { ws, ids };
  }

  it("lists runs newest first and finds the latest", async () => {
    const { ws, ids } = await workspaceWithRuns(3);
    const runs = await listRuns(ws);
    expect(runs.map((r) => r.id)).toEqual([...ids].reverse());
    expect(runs[0]).toMatchObject({ verdict: "passed" });
    expect((await latestRun(ws))?.id).toBe(ids[2]);
    expect(await latestRun(tmp())).toBeUndefined();
  });

  it("prunes by --keep N", async () => {
    const { ws, ids } = await workspaceWithRuns(4);
    const result = await pruneRuns(ws, { keep: 1 });
    expect(result.removed.sort()).toEqual(ids.slice(0, 3).sort());
    expect((await listRuns(ws)).map((r) => r.id)).toEqual([ids[3]]);
    expect(existsSync(join(runsRootFor(ws), "not-a-run"))).toBe(true);
  });

  it("prunes by --older-than", async () => {
    const { ws, ids } = await workspaceWithRuns(3);
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 2, 500));
    const result = await pruneRuns(ws, { olderThanMs: 1000, now });
    expect(result.removed.sort()).toEqual(ids.slice(0, 2).sort());
  });

  it("never lists or selects a forged run (audit I2)", async () => {
    const { ws, ids } = await workspaceWithRuns(2);
    const forged = "run_7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    cpSync(join(runsRootFor(ws), ids[1]!), join(runsRootFor(ws), forged), { recursive: true });
    expect((await listRuns(ws)).map((r) => r.id)).toEqual([...ids].reverse());
    expect((await latestRun(ws))?.id).toBe(ids[1]);
    const all = await listRuns(ws, { includeInvalid: true });
    expect(all.find((r) => r.id === forged)?.integrity).toBe("integrity_failed");
  });

  it("prune refuses run directories that are symlinks (audit I6)", async () => {
    const { ws } = await workspaceWithRuns(1);
    const outside = tmp();
    mkdirSync(join(outside, "precious"));
    symlinkSync(outside, join(runsRootFor(ws), "run_00000000000000000000000000"));
    await pruneRuns(ws, { keep: 0 });
    expect(existsSync(join(outside, "precious"))).toBe(true);
  });

  it("requires a criterion", async () => {
    await expect(pruneRuns(tmp(), {})).rejects.toMatchObject({ code: "invalid-config" });
  });
});

describe(
  "repositoryState is hardened against repo-controlled git config (audit I4)",
  { timeout: 60_000 },
  () => {
    it("never runs fsmonitor, external diff or hooks from the repo config", async () => {
      const repo = gitRepo();
      const marker = join(tmp(), "fsmonitor-ran");
      git(repo, "config", "core.fsmonitor", `touch ${marker}; false`);
      git(repo, "config", "diff.external", "/usr/bin/true");
      writeFileSync(join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
      git(repo, "config", "filter.evil.clean", `touch ${marker}.filter; cat`);
      git(repo, "config", "diff.evil.textconv", `touch ${marker}.textconv; cat`);
      const first = await repositoryState(repo);
      writeFileSync(join(repo, "a.txt"), "changed\n");
      const second = await repositoryState(repo);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.filter`)).toBe(false);
      expect(existsSync(`${marker}.textconv`)).toBe(false);
      expect(second.dirtyTreeDigest).not.toBe(first.dirtyTreeDigest);
    });

    it("ignores GIT_* variables in the caller environment", async () => {
      const repo = gitRepo();
      const head = git(repo, "rev-parse", "HEAD");
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = "/nonexistent-git-dir";
      try {
        expect((await repositoryState(repo)).commitSha).toBe(head);
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }
    });

    it("the tree digest covers ignored files (e.g. node_modules/.bin)", async () => {
      const repo = gitRepo();
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
      mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(repo, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexit 0\n");
      const before = await repositoryState(repo);
      writeFileSync(
        join(repo, "node_modules", ".bin", "vitest"),
        "#!/bin/sh\necho patched; exit 0\n",
      );
      const after = await repositoryState(repo);
      expect(after.dirtyTreeDigest).not.toBe(before.dirtyTreeDigest);
    });

    it("covers symlinks by their target without following them", async () => {
      const repo = gitRepo();
      symlinkSync("/etc/hosts", join(repo, "link"));
      const a = await repositoryState(repo);
      execFileSync("rm", [join(repo, "link")]);
      symlinkSync("/etc/passwd", join(repo, "link"));
      expect((await repositoryState(repo)).dirtyTreeDigest).not.toBe(a.dirtyTreeDigest);
    });
  },
);

describe("runs are bound to their workspace and runs root (fix round 2, I4)", () => {
  it("a run copied from workspace A's store into B's is rejected by list, latest and read", async () => {
    const a = tmp();
    const b = tmp();
    const run = await createRun(a);
    await finalizeRun(run.dir, baseReport(run.id), { workspace: a });
    expect((await readReport(run.dir, { workspace: a })).integrity.status).toBe("ok");
    expect((await listRuns(a)).map((r) => r.id)).toEqual([run.id]);

    mkdirSync(runsRootFor(b), { recursive: true });
    cpSync(run.dir, join(runsRootFor(b), run.id), { recursive: true });
    expect(await listRuns(b)).toEqual([]);
    expect(await latestRun(b)).toBeUndefined();
    const copied = await readReport(join(runsRootFor(b), run.id), { workspace: b });
    expect(copied.integrity.status).toBe("integrity_failed");
    expect(copied.integrity.problems.join()).toMatch(/another workspace|another runs root/);
    // even without knowing the workspace, a run moved to another root is detected
    expect((await readReport(join(runsRootFor(b), run.id))).integrity.problems.join()).toMatch(
      /another runs root/,
    );
  });

  it("a manifest that does not bind a workspace is rejected", async () => {
    const ws = tmp();
    const run = await createRun(ws);
    await finalizeRun(run.dir, baseReport(run.id));
    expect((await readReport(run.dir)).integrity.problems.join()).toMatch(
      /does not bind a workspace/,
    );
  });
});

describe("tree digest excludes only .git and the source cache (fix round 2, minor 10)", () => {
  it("content stashed in the workspace's .brokkr/runs changes the digest", async () => {
    const repo = gitRepo();
    const before = await repositoryState(repo);
    mkdirSync(join(repo, ".brokkr", "runs", "stash"), { recursive: true });
    writeFileSync(join(repo, ".brokkr", "runs", "stash", "payload"), "x");
    expect((await repositoryState(repo)).dirtyTreeDigest).not.toBe(before.dirtyTreeDigest);
  }, 30_000);
});

describe("readReport and store edge cases (coverage)", () => {
  async function signedRun() {
    const ws = tmp();
    const run = await createRun(ws);
    writeFileSync(run.logPath("tests"), "ok\n");
    await finalizeRun(run.dir, baseReport(run.id), { workspace: ws });
    return { ws, run };
  }

  it("rejects malformed report.json and schema-invalid reports", async () => {
    const { run } = await signedRun();
    writeFileSync(join(run.dir, "report.json"), "{");
    await expect(readReport(run.dir)).rejects.toMatchObject({ code: "integrity" });
    writeFileSync(join(run.dir, "report.json"), JSON.stringify({ schemaVersion: "1.0" }));
    await expect(readReport(run.dir)).rejects.toMatchObject({ code: "integrity" });
  });

  it("flags a non-JSON manifest, a manifest without artifacts, escaping paths and mismatched evidence", async () => {
    const a = await signedRun();
    writeFileSync(join(a.run.dir, EVIDENCE_MANIFEST), "{");
    expect((await readReport(a.run.dir)).integrity.problems.join()).toMatch(/not valid JSON/);
    writeFileSync(join(a.run.dir, EVIDENCE_MANIFEST), JSON.stringify({ runId: a.run.id }));
    expect((await readReport(a.run.dir)).integrity.problems.join()).toMatch(/no artifact list/);

    const b = await signedRun();
    const path = join(b.run.dir, EVIDENCE_MANIFEST);
    const m = JSON.parse(readFileSync(path, "utf8"));
    m.artifacts.push({
      path: "../outside",
      sha256: `sha256:${"0".repeat(64)}`,
      bytes: 0,
      producedBy: "x",
      kind: "log",
    });
    m.artifacts = m.artifacts.filter((x: { path: string }) => x.path !== "logs/tests.log");
    writeFileSync(path, JSON.stringify(m));
    const problems = (await readReport(b.run.dir)).integrity.problems.join("\n");
    expect(problems).toMatch(/escapes the run directory/);
    expect(problems).toMatch(/report evidence does not match the manifest/);
  });

  it("an explicit runsRoot is created; prune refuses a symlinked runs root", async () => {
    const ws = tmp();
    const root = join(tmp(), "deep", "runs");
    const run = await createRun(ws, { runsRoot: root });
    expect(run.dir.startsWith(root)).toBe(true);
    expect(run.testResultsDir("c")).toBe(join(run.dir, "test-results", "c"));

    const other = tmp();
    const outside = tmp();
    mkdirSync(join(runsRootFor(other), ".."), { recursive: true });
    symlinkSync(outside, runsRootFor(other));
    await expect(pruneRuns(other, { keep: 0 })).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("the tree digest records special files", async () => {
    const repo = gitRepo();
    const before = await repositoryState(repo);
    execFileSync("mkfifo", [join(repo, "fifo")]);
    expect((await repositoryState(repo)).dirtyTreeDigest).not.toBe(before.dirtyTreeDigest);
  }, 30_000);
});
