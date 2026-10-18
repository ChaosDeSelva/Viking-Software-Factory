import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, commitFile, makeRepo, sh } from "../test/helpers.js";
import { GitManager, type CreateWorktreeInput } from "./manager.js";

/**
 * Fix round 2 probes (T10-fix1-review N1, N2): nested repositories / submodules inside a worktree
 * must never be read through, and the working-tree snapshot must never follow a symlinked
 * ancestor directory out of the worktree.
 */
const CANARY = "canary-n1-hunter2";
const dirs = new TempDirs();
let repo: string;
let root: string;
let sentinel: string;
let driver: string;
let mgr: GitManager;
let projectId: ProjectId;

function input(over: Partial<CreateWorktreeInput> = {}): CreateWorktreeInput {
  return {
    projectId,
    repoPath: repo,
    taskId: newId("tsk") as TaskId,
    crewSlug: "core",
    taskSlug: "nested",
    ...over,
  };
}

async function sentinelText(): Promise<string> {
  return existsSync(sentinel) ? await readFile(sentinel, "utf8") : "";
}

/** A repo at `dir` with one committed file, then a clean filter planted in its own config. */
async function plantNestedRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "f.txt"), "nested\n");
  sh(dir, "add", "f.txt");
  sh(dir, "commit", "-q", "-m", "nested");
  sh(dir, "config", "--local", "filter.evil.clean", `${driver} clean`);
  await writeFile(join(dir, ".git", "info", "attributes"), "* filter=evil\n");
}

beforeEach(async () => {
  process.env.MIMIR_CANARY = CANARY;
  repo = await makeRepo(dirs);
  root = await dirs.make("root");
  const tools = await dirs.make("tools");
  sentinel = join(tools, "sentinel.txt");
  driver = join(tools, "driver.sh");
  await writeFile(driver, `#!/bin/sh\necho "$1:$MIMIR_CANARY:$(whoami)" >> '${sentinel}'\ncat\n`);
  await chmod(driver, 0o755);
  projectId = newId("prj") as ProjectId;
  mgr = new GitManager({ worktreeRoot: root });
});

afterEach(async () => {
  delete process.env.MIMIR_CANARY;
  await dirs.cleanup();
});

describe("N1: nested repositories and submodules are never read through", () => {
  it("harness control: plain git status recurses into the gitlink and runs its filter", async () => {
    const w = await mgr.createWorktree(input());
    const sub = join(w.path, "sub");
    await plantNestedRepo(sub);
    sh(w.path, "add", "sub");
    sh(w.path, "commit", "-q", "-m", "gitlink");
    const later = new Date(Date.now() + 5000);
    await utimes(join(sub, "f.txt"), later, later);
    sh(w.path, "status", "--porcelain", "--ignore-submodules=none");
    expect(await sentinelText()).toContain("clean:");
  });

  it("removeWorktree fails closed on a committed gitlink without running its filter", async () => {
    const w = await mgr.createWorktree(input());
    const sub = join(w.path, "sub");
    await plantNestedRepo(sub);
    sh(w.path, "add", "sub");
    sh(w.path, "commit", "-q", "-m", "gitlink");
    const later = new Date(Date.now() + 5000);
    await utimes(join(sub, "f.txt"), later, later);

    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "policy_denied",
      details: expect.objectContaining({ paths: ["sub"] }),
    });
    expect(await sentinelText()).toBe("");
    expect(existsSync(w.path)).toBe(true);
  });

  it("removeWorktree fails closed on an untracked nested repository", async () => {
    const w = await mgr.createWorktree(input());
    await plantNestedRepo(join(w.path, "deep", "inner"));
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "policy_denied",
      details: expect.objectContaining({ paths: ["deep/inner"] }),
    });
    expect(await sentinelText()).toBe("");
  });

  it("removeWorktree fails closed on a nested .git file (linked worktree / submodule gitdir file)", async () => {
    const w = await mgr.createWorktree(input());
    await mkdir(join(w.path, "x"));
    await writeFile(join(w.path, "x", ".git"), "gitdir: /nonexistent\n");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "policy_denied",
      details: expect.objectContaining({ paths: ["x"] }),
    });
  });

  it("diff with includeWorkingTree fails closed on nested repositories; committed diff still works", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "c.txt", "c\n", "c");
    await plantNestedRepo(join(w.path, "sub"));
    await expect(mgr.diff(w.id, { includeWorkingTree: true })).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect((await mgr.diff(w.id)).files.map((f) => f.path)).toEqual(["c.txt"]);
    expect(await sentinelText()).toBe("");
  });

  it("a clean tree without nested repos is still removed (dirtiness from the scratch snapshot)", async () => {
    const w = await mgr.createWorktree(input());
    const later = new Date(Date.now() + 5000);
    await utimes(join(w.path, "a.txt"), later, later); // stat-only change is not dirt
    await expect(mgr.removeWorktree(w.id)).resolves.toMatchObject({
      removed: true,
      branchDeleted: true,
    });
  });
});

describe("fix round 3 I1: staged-only changes are dirty", () => {
  it("MM: staged content with the working file restored to HEAD refuses removal", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "a.txt"), "staged\n");
    sh(w.path, "add", "a.txt");
    await writeFile(join(w.path, "a.txt"), "one\ntwo\nthree\n");
    expect(sh(w.path, "status", "--porcelain")).toBe("MM a.txt");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ dirty: ["a.txt"] }),
    });
    expect(existsSync(w.path)).toBe(true);
    expect((await mgr.diff(w.id, { includeWorkingTree: true })).dirty).toBe(true);
  });

  it("AD: a staged new file deleted from disk refuses removal", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "n.txt"), "new\n");
    sh(w.path, "add", "n.txt");
    await rm(join(w.path, "n.txt"));
    expect(sh(w.path, "status", "--porcelain")).toBe("AD n.txt");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ dirty: ["n.txt"] }),
    });
  });

  it("a path removed from the index only (git rm --cached) refuses removal", async () => {
    const w = await mgr.createWorktree(input());
    sh(w.path, "rm", "-q", "--cached", "b.txt");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ dirty: ["b.txt"] }),
    });
  });

  it("an unmerged index entry refuses removal even when the file matches HEAD", async () => {
    const w = await mgr.createWorktree(input());
    sh(w.path, "checkout", "-q", "-b", "side");
    await commitFile(w.path, "a.txt", "one\nSIDE\nthree\n", "side");
    sh(w.path, "checkout", "-q", w.branch);
    await commitFile(w.path, "a.txt", "one\nMINE\nthree\n", "mine");
    expect(() => sh(w.path, "merge", "side")).toThrow();
    await writeFile(join(w.path, "a.txt"), "one\nMINE\nthree\n");
    expect(sh(w.path, "ls-files", "-u")).not.toBe("");
    // Make the committed work count as merged so only the index state can refuse.
    sh(repo, "merge", "-q", "--ff-only", sh(w.path, "rev-parse", "HEAD"));
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ dirty: ["a.txt"] }),
    });
  });
});

describe("fix round 3 I2: nested repos regardless of .git case", () => {
  it.each([".GIT", ".Git"])(
    "a nested %s repository with untracked work denies removal",
    async (name) => {
      const w = await mgr.createWorktree(input());
      const up = join(w.path, "up");
      await mkdir(up);
      sh(up, "init", "-q", "-b", "main");
      await rename(join(up, ".git"), join(up, `${name}-tmp`));
      await rename(join(up, `${name}-tmp`), join(up, name));
      await writeFile(join(up, "work.txt"), "precious\n");
      await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
        code: "policy_denied",
        details: expect.objectContaining({ paths: ["up"] }),
      });
      expect(existsSync(join(up, "work.txt"))).toBe(true);
    },
  );

  it("any untracked directory entry reported by ls-files (nested repo) is denied", async () => {
    const w = await mgr.createWorktree(input());
    const up = join(w.path, "up");
    await mkdir(up);
    sh(up, "init", "-q", "-b", "main");
    await writeFile(join(up, "work.txt"), "precious\n");
    await expect(mgr.diff(w.id, { includeWorkingTree: true })).rejects.toMatchObject({
      code: "policy_denied",
    });
  });
});

describe("N2: snapshot never follows symlinked ancestors", () => {
  it("an outside file reached through a symlinked directory never appears in the diff", async () => {
    const w = await mgr.createWorktree(input());
    await mkdir(join(w.path, "d"));
    await commitFile(w.path, "d/secret.txt", "inside\n", "add d");
    const outside = await dirs.make("outside");
    await writeFile(join(outside, "secret.txt"), "TOPSECRET-ANCESTOR\n");
    await rm(join(w.path, "d"), { recursive: true });
    await symlink(outside, join(w.path, "d"));

    const err = await mgr.diff(w.id, { includeWorkingTree: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "policy_denied",
      details: expect.objectContaining({ paths: ["d/secret.txt"] }),
    });
    expect(JSON.stringify(err)).not.toContain("TOPSECRET");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({ code: "policy_denied" });
  });

  it("a FIFO in the working tree does not hang the snapshot", async () => {
    const w = await mgr.createWorktree(input());
    execFileSync("mkfifo", [join(w.path, "pipe")]);
    const d = await mgr.diff(w.id, { includeWorkingTree: true });
    expect(d.files.map((f) => f.path)).toEqual([]);
  });
});

describe("m4: restore keeps the original baseRef", () => {
  it("uses the persisted baseRef for merged semantics after restart", async () => {
    sh(repo, "branch", "dev");
    const w = await mgr.createWorktree(input({ baseRef: "dev" }));
    expect(mgr.baseRefOf(w.id)).toBe("dev");
    await commitFile(w.path, "x.txt", "x\n", "work");
    sh(repo, "branch", "-f", "dev", sh(w.path, "rev-parse", "HEAD"));

    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([{ ...w, baseRef: "dev" }]);
    expect(res.rejected).toEqual([]);
    expect(fresh.baseRefOf(w.id)).toBe("dev");
    // Merged into dev (not main): removal succeeds and the branch is deleted.
    await expect(fresh.removeWorktree(w.id)).resolves.toMatchObject({ branchDeleted: true });
  });

  it("rejects an option-like persisted baseRef", async () => {
    const w = await mgr.createWorktree(input());
    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([{ ...w, baseRef: "--evil" }]);
    expect(res.restored).toEqual([]);
    expect(res.rejected).toHaveLength(1);
  });
});
