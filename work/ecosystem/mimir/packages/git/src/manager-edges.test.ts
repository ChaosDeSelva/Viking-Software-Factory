import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TempDirs, commitFile, makeRepo, sh } from "../test/helpers.js";
import { GitManager, OWNER_FILE, SCRATCH_DIR, type CreateWorktreeInput } from "./manager.js";

const dirs = new TempDirs();
let repo: string;
let root: string;
let projectId: ProjectId;
let mgr: GitManager;

function input(over: Partial<CreateWorktreeInput> = {}): CreateWorktreeInput {
  return {
    projectId,
    repoPath: repo,
    taskId: newId("tsk") as TaskId,
    crewSlug: "core",
    taskSlug: "edge",
    ...over,
  };
}

beforeEach(async () => {
  repo = await makeRepo(dirs);
  root = await dirs.make("root");
  projectId = newId("prj") as ProjectId;
  mgr = new GitManager({ worktreeRoot: root });
});

afterEach(async () => {
  await dirs.cleanup();
});

describe("construction", () => {
  it("refuses a worktree root inside $MIMIR_DATA_DIR", async () => {
    const data = await dirs.make("data");
    vi.stubEnv("MIMIR_DATA_DIR", data);
    try {
      expect(() => new GitManager({ worktreeRoot: join(data, "wt") })).toThrow(
        expect.objectContaining({
          code: "validation_failed",
          details: expect.objectContaining({ dataDir: data }),
        }),
      );
      expect(new GitManager({ worktreeRoot: root }).worktreeRoot).toBe(root);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("registerProject", () => {
  it("rejects a repoPath that does not exist", async () => {
    await expect(
      mgr.registerProject({ projectId, repoPath: join(repo, "missing") }),
    ).rejects.toMatchObject({ code: "validation_failed", message: "repoPath does not exist" });
  });
});

describe("createWorktree defaults and the claim-file exclude", () => {
  it("starts from origin/HEAD when the clone has one", async () => {
    const upstream = await commitFile(repo, "up.txt", "up\n", "upstream");
    sh(repo, "reset", "-q", "--hard", "HEAD~1");
    sh(repo, "update-ref", "refs/remotes/origin/main", upstream);
    sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const w = await mgr.createWorktree(input());
    expect(w.baseSha).toBe(upstream);
    expect(mgr.baseRefOf(w.id)).toBe("origin/main");
  });

  it("creates info/exclude when the clone has none", async () => {
    await rm(join(repo, ".git", "info"), { recursive: true, force: true });
    await mgr.createWorktree(input());
    expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toBe(`/${OWNER_FILE}\n`);
  });

  it("appends to an exclude file that lacks a final newline, once", async () => {
    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await writeFile(join(repo, ".git", "info", "exclude"), "*.log");
    await mgr.createWorktree(input());
    await mgr.createWorktree(input());
    expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toBe(
      `*.log\n/${OWNER_FILE}\n`,
    );
  });

  it("writes the exclude into the common dir when the project is itself a linked worktree", async () => {
    const main = await makeRepo(dirs);
    const linkedParent = await dirs.make("linked");
    const linked = join(linkedParent, "checkout");
    sh(main, "worktree", "add", "-q", "-b", "side", linked);
    const w = await mgr.createWorktree(input({ repoPath: linked }));
    expect(await readFile(join(main, ".git", "info", "exclude"), "utf8")).toContain(
      `/${OWNER_FILE}`,
    );
    expect(sh(w.path, "status", "--porcelain")).toBe("");
  });
});

describe("restore edge cases", () => {
  it("rejects a record whose path does not match its task and a non-string baseRef", async () => {
    const w = await mgr.createWorktree(input());
    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([
      { ...w, path: join(root, projectId, newId("tsk")) },
      { ...w, baseRef: 42 as unknown as string },
    ]);
    expect(res.restored).toEqual([]);
    expect(res.rejected.map((r) => r.reason)).toEqual([
      "unexpected path",
      "baseRef must be a string",
    ]);
  });

  it("falls back to baseSha as the base ref when the clone has no default branch", async () => {
    const w = await mgr.createWorktree(input());
    sh(repo, "checkout", "-q", "--detach");
    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([w]);
    expect(res.restored.map((r) => r.id)).toEqual([w.id]);
    expect(fresh.baseRefOf(w.id)).toBe(w.baseSha);
  });

  it("get returns undefined for an unknown id", () => {
    expect(mgr.get(newId("wtr"))).toBeUndefined();
  });
});

describe("removeWorktree edge cases", () => {
  it("prunes a worktree whose directory is gone and keeps a missing branch missing", async () => {
    const w = await mgr.createWorktree(input());
    await rm(w.path, { recursive: true, force: true });
    sh(repo, "update-ref", "-d", `refs/heads/${w.branch}`);
    const r = await mgr.removeWorktree(w.id);
    expect(r).toMatchObject({ removed: true, forced: false, branchDeleted: false });
    expect(r.branchDeleteError).toBeUndefined();
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(w.path);
  });

  it("records the approval id on a forced removal", async () => {
    const w = await mgr.createWorktree(input());
    const r = await mgr.removeWorktree(w.id, { force: true, approvalId: "apr_test" });
    expect(r).toMatchObject({ forced: true, approvalId: "apr_test", branchDeleted: true });
  });

  it("reports a branch that could not be deleted without failing the removal", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(repo, ".git", "refs", "heads", `${w.branch}.lock`), "");
    const r = await mgr.removeWorktree(w.id);
    expect(r.branchDeleted).toBe(false);
    expect(r.branchDeleteError).toMatch(/branch/);
    expect(mgr.get(w.id)?.status).toBe("removed");
  });

  it("measures merged work against baseSha once the base ref no longer resolves", async () => {
    sh(repo, "branch", "feature");
    const w = await mgr.createWorktree(input({ baseRef: "feature" }));
    sh(repo, "branch", "-D", "feature");
    await expect(mgr.removeWorktree(w.id)).resolves.toMatchObject({ branchDeleted: true });
    await commitFile(repo, "later.txt", "x\n", "later");
    const w2 = await mgr.createWorktree(input({ baseRef: "main" }));
    await commitFile(w2.path, "w.txt", "w\n", "work");
    sh(repo, "branch", "-m", "main", "renamed");
    await expect(mgr.removeWorktree(w2.id)).rejects.toMatchObject({
      code: "conflict",
      details: { unmergedCommits: 1 },
    });
  });

  it("ignores a claim file force-added to the index when checking for changes", async () => {
    const w = await mgr.createWorktree(input());
    sh(w.path, "add", "-f", OWNER_FILE);
    await expect(mgr.removeWorktree(w.id)).resolves.toMatchObject({ removed: true });
  });

  it("skips directories it cannot read while looking for nested repositories", async () => {
    const w = await mgr.createWorktree(input());
    const locked = join(w.path, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const d = await mgr.diff(w.id, { includeWorkingTree: true });
      expect(d.files).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe("scratch repository failures", () => {
  it("does not cache a scratch repository that failed to open", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(root, SCRATCH_DIR), "not a directory");
    await expect(mgr.diff(w.id)).rejects.toThrow();
    await rm(join(root, SCRATCH_DIR));
    await expect(mgr.diff(w.id)).resolves.toMatchObject({ files: [] });
  });
});

describe("diff ordering", () => {
  it("sorts files by UTF-16 code units, not git's byte order", async () => {
    const w = await mgr.createWorktree(input());
    const high = "！.txt";
    const astral = "\u{1F600}.txt";
    await writeFile(join(w.path, high), "a\n");
    await writeFile(join(w.path, astral), "b\n");
    sh(w.path, "add", "--", high, astral);
    sh(w.path, "commit", "-q", "-m", "names");
    const d = await mgr.diff(w.id);
    expect(d.files.map((f) => f.path)).toEqual([astral, high]);
  });
});

describe("exportResult guards", () => {
  it("refuses an export without bases or results", async () => {
    await expect(mgr.exportResult(projectId, repo, [], ["a".repeat(40)])).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(mgr.exportResult(projectId, repo, ["a".repeat(40)], [])).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("claim edge cases", () => {
  it("rejects an empty or over-long session id", async () => {
    const w = await mgr.createWorktree(input());
    for (const sessionId of ["", "s".repeat(201)]) {
      await expect(mgr.claim(w.path, sessionId)).rejects.toMatchObject({
        code: "validation_failed",
      });
    }
  });

  it("hands the worktree to a new task when the injected liveness check says the owner is gone", async () => {
    const live = new Set<string>();
    const m = new GitManager({ worktreeRoot: root, isTaskLive: (t) => live.has(t) });
    const w = await m.createWorktree(input());
    live.add(w.taskId);
    const next = newId("tsk") as TaskId;
    await expect(m.claim(w.path, newId("ses"), { taskId: next })).rejects.toMatchObject({
      code: "conflict",
    });
    live.delete(w.taskId);
    const session = newId("ses");
    await expect(m.claim(w.path, session, { taskId: next })).resolves.toMatchObject({
      taskId: next,
      sessionId: session,
    });
  });

  it("refuses a claim file that is a directory or too large", async () => {
    const w = await mgr.createWorktree(input());
    const file = join(w.path, OWNER_FILE);
    await rm(file);
    await mkdir(file);
    await expect(mgr.claim(w.path, newId("ses"))).rejects.toMatchObject({
      code: "conflict",
      message: "ownership claim is not a small regular file",
    });
    await rm(file, { recursive: true });
    await writeFile(file, " ".repeat(64 * 1024 + 1));
    await expect(mgr.claim(w.path, newId("ses"))).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(file)).toBe(true);
  });
});
