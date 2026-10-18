import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, commitFile, makeRepo, sh } from "../test/helpers.js";
import {
  DEFAULT_WORKTREE_ROOT,
  GitManager,
  OWNER_FILE,
  defaultWorktreeRoot,
  type CreateWorktreeInput,
} from "./manager.js";

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
    taskSlug: "do-thing",
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

describe("GitManager construction", () => {
  it("defaults worktreeRoot outside the data dir, at ~/.mimir-work/worktrees (audit H1)", () => {
    expect(DEFAULT_WORKTREE_ROOT).toBe(join(homedir(), ".mimir-work", "worktrees"));
    expect(defaultWorktreeRoot({})).toBe(DEFAULT_WORKTREE_ROOT);
    expect(new GitManager({ dataDirs: [] }).worktreeRoot).toBe(defaultWorktreeRoot());
  });
  it("honours MIMIR_WORKTREE_ROOT for the default", () => {
    expect(defaultWorktreeRoot({ MIMIR_WORKTREE_ROOT: "/srv/wt" })).toBe("/srv/wt");
    expect(defaultWorktreeRoot({ MIMIR_WORKTREE_ROOT: "  " })).toBe(DEFAULT_WORKTREE_ROOT);
  });
  it("refuses a worktreeRoot inside (or equal to) Mimir's data dir (audit H1)", () => {
    for (const worktreeRoot of [
      join(homedir(), ".mimir", "worktrees"),
      join(homedir(), ".mimir"),
    ]) {
      expect(() => new GitManager({ worktreeRoot })).toThrow(
        expect.objectContaining({ code: "validation_failed" }),
      );
    }
    expect(() => new GitManager({ worktreeRoot: `${root}/wt`, dataDirs: [root] })).toThrow(
      /must not be inside the Mimir data dir/,
    );
    expect(() => new GitManager({ worktreeRoot: root, dataDirs: [`${root}-data`] })).not.toThrow();
  });
  it("refuses a worktreeRoot that resolves into the data dir through a symlink", async () => {
    const data = await dirs.make("data");
    const link = join(await dirs.make("links"), "wt");
    await symlink(data, link);
    const m = new GitManager({ worktreeRoot: link, dataDirs: [data] });
    await expect(m.registerProject({ projectId, repoPath: repo })).resolves.toBeDefined();
    await expect(m.createWorktree(input())).rejects.toThrow(
      /must not be inside the Mimir data dir/,
    );
  });
  it("rejects a worktreeRoot with .. segments", () => {
    expect(() => new GitManager({ worktreeRoot: `${root}/../x` })).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });
});

describe("createWorktree", () => {
  it("creates disjoint worktrees and branches for two tasks on one repo", async () => {
    const t1 = newId("tsk") as TaskId;
    const t2 = newId("tsk") as TaskId;
    const head = sh(repo, "rev-parse", "HEAD");
    const w1 = await mgr.createWorktree(input({ taskId: t1, taskSlug: "first" }));
    const w2 = await mgr.createWorktree(input({ taskId: t2, crewSlug: "web", taskSlug: "second" }));

    expect(w1.path).toBe(join(root, projectId, t1));
    expect(w2.path).toBe(join(root, projectId, t2));
    expect(w1.branch).toBe(`mimir/core/${t1}-first`);
    expect(w2.branch).toBe(`mimir/web/${t2}-second`);
    expect(w1.path).not.toBe(w2.path);
    expect(w1.branch).not.toBe(w2.branch);
    for (const [w, t] of [
      [w1, t1],
      [w2, t2],
    ] as const) {
      expect(w.id).toMatch(/^wtr_/);
      expect(w.taskId).toBe(t);
      expect(w.status).toBe("active");
      expect(w.baseSha).toBe(head);
      expect(w.version).toBe(0);
      expect(sh(w.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(w.branch);
      const owner = JSON.parse(await readFile(join(w.path, OWNER_FILE), "utf8"));
      expect(owner.taskId).toBe(t);
      expect(typeof owner.createdAt).toBe("string");
      // The claim file is ignored, so the fresh tree is clean.
      expect(sh(w.path, "status", "--porcelain")).toBe("");
    }
    // The primary clone stays on main and untouched.
    expect(sh(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(mgr.list().map((w) => w.id)).toEqual([w1.id, w2.id]);
    expect(mgr.get(w1.id)).toEqual(w1);
  });

  it("uses an explicit baseRef and records its sha", async () => {
    const first = sh(repo, "rev-parse", "HEAD");
    await commitFile(repo, "c.txt", "c\n", "second");
    const w = await mgr.createWorktree(input({ baseRef: first }));
    expect(w.baseSha).toBe(first);
  });

  it("refuses when the branch already exists", async () => {
    const taskId = newId("tsk") as TaskId;
    sh(repo, "branch", `mimir/core/${taskId}-do-thing`);
    await expect(mgr.createWorktree(input({ taskId }))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("refuses a second worktree for the same task", async () => {
    const taskId = newId("tsk") as TaskId;
    await mgr.createWorktree(input({ taskId }));
    await expect(mgr.createWorktree(input({ taskId, taskSlug: "other" }))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it.each([
    ["crewSlug", { crewSlug: "Core" }],
    ["taskSlug", { taskSlug: "a/b" }],
    ["taskSlug", { taskSlug: "x".repeat(41) }],
  ])("rejects an invalid %s", async (_f, over) => {
    await expect(mgr.createWorktree(input(over))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects traversal through ids and paths", async () => {
    await expect(
      mgr.createWorktree(input({ projectId: "../../etc" as ProjectId })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(mgr.createWorktree(input({ taskId: "../x" as TaskId }))).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(
      mgr.createWorktree(input({ repoPath: `${repo}/../${repo.split("/").pop()}` })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(mgr.createWorktree(input({ baseRef: "--orphan" }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a symlinked worktree target and creates nothing outside the root", async () => {
    const outside = await dirs.make("outside");
    await symlink(outside, join(root, projectId));
    await expect(mgr.createWorktree(input())).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(await readdir(outside)).toEqual([]);
    expect(sh(repo, "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
  });

  it("rejects a symlinked task directory", async () => {
    const outside = await dirs.make("outside");
    const taskId = newId("tsk") as TaskId;
    await mkdir(join(root, projectId));
    await symlink(outside, join(root, projectId, taskId));
    await expect(mgr.createWorktree(input({ taskId }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a repoPath that is not a git repository", async () => {
    const plain = await dirs.make("plain");
    await expect(mgr.createWorktree(input({ repoPath: plain }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a repoPath that is a subdirectory of a repo", async () => {
    await mkdir(join(repo, "sub"));
    await expect(mgr.createWorktree(input({ repoPath: join(repo, "sub") }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a repoPath under the worktree root", async () => {
    const inner = join(root, "nested-repo");
    await mkdir(inner);
    sh(inner, "init", "-q", "-b", "main");
    await expect(mgr.createWorktree(input({ repoPath: inner }))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("rejects a worktreeRoot inside a registered project", async () => {
    const inside = new GitManager({ worktreeRoot: join(repo, ".mimir-wt") });
    await expect(inside.createWorktree(input())).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(inside.registerProject({ projectId, repoPath: repo })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(existsSync(join(repo, ".mimir-wt"))).toBe(false);
  });

  it("resolves a symlinked repoPath to its real path", async () => {
    const linkDir = await dirs.make("link");
    const link = join(linkDir, "repo-link");
    await symlink(repo, link);
    await expect(mgr.registerProject({ projectId, repoPath: link })).resolves.toBe(repo);
  });

  it("refuses to create a branch that matches a protected rule", async () => {
    const guarded = new GitManager({ worktreeRoot: root, protectedBranches: ["mimir/*"] });
    await expect(guarded.createWorktree(input())).rejects.toMatchObject({
      code: "policy_denied",
    });
  });
});

describe("removeWorktree", () => {
  it("refuses a dirty tree (modified tracked file)", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "a.txt"), "changed\n");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(w.path)).toBe(true);
    expect(mgr.get(w.id)?.status).toBe("active");
  });

  it("reports both paths of a staged rename as dirty", async () => {
    const w = await mgr.createWorktree(input());
    sh(w.path, "mv", "a.txt", "renamed.txt");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ dirty: ["a.txt", "renamed.txt"] }),
    });
  });

  it("refuses a tree with untracked files", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "new.txt"), "x\n");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses unmerged commits and keeps the branch even when forced", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "a.txt", "work\n", "work");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "conflict",
      details: expect.objectContaining({ unmergedCommits: 1 }),
    });
    await expect(mgr.removeWorktree(w.id, { force: true })).rejects.toMatchObject({
      code: "validation_failed",
    });
    const res = await mgr.removeWorktree(w.id, {
      force: true,
      approvalId: newId("apr"),
    });
    expect(res).toMatchObject({ removed: true, branchDeleted: false, forced: true });
    expect(existsSync(w.path)).toBe(false);
    expect(sh(repo, "branch", "--list", w.branch)).toContain(w.branch);
    expect(mgr.get(w.id)?.status).toBe("removed");
  });

  it("force-removes a dirty tree with an approval id", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "a.txt"), "changed\n");
    const approvalId = newId("apr");
    const res = await mgr.removeWorktree(w.id, { force: true, approvalId });
    expect(res).toMatchObject({ removed: true, forced: true, approvalId });
    expect(existsSync(w.path)).toBe(false);
  });

  it("removes a clean tree and deletes its (trivially merged) branch", async () => {
    const w = await mgr.createWorktree(input());
    const res = await mgr.removeWorktree(w.id);
    expect(res).toMatchObject({ removed: true, branchDeleted: true, forced: false });
    expect(existsSync(w.path)).toBe(false);
    expect(sh(repo, "branch", "--list", w.branch)).toBe("");
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(w.path);
    const after = mgr.get(w.id);
    expect(after?.status).toBe("removed");
    expect(after?.version).toBe(1);
  });

  it("removes a tree whose commits were merged into base and deletes the branch", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "c.txt", "c\n", "feature");
    sh(repo, "merge", "-q", "--no-ff", "-m", "merge", w.branch);
    const res = await mgr.removeWorktree(w.id);
    expect(res).toMatchObject({ removed: true, branchDeleted: true });
    expect(sh(repo, "branch", "--list", w.branch)).toBe("");
  });

  it("rejects unknown and already-removed ids", async () => {
    await expect(mgr.removeWorktree(newId("wtr"))).rejects.toMatchObject({ code: "not_found" });
    const w = await mgr.createWorktree(input());
    await mgr.removeWorktree(w.id);
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });
});

describe("diff, manifest and commits", () => {
  async function setup() {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "a.txt", "one\nTWO\nthree\nfour\n", "edit a");
    await unlink(join(w.path, "b.txt"));
    await writeFile(join(w.path, "new.txt"), "n1\nn2\n");
    return w;
  }

  it("is committed-only by default: baseSha..HEAD, ignoring the working tree", async () => {
    const w = await setup();
    const d = await mgr.diff(w.id);
    expect(d.files).toEqual([{ path: "a.txt", status: "modified", additions: 2, deletions: 1 }]);
    expect(d).toMatchObject({
      baseSha: w.baseSha,
      headSha: sh(w.path, "rev-parse", "HEAD"),
      includesWorkingTree: false,
      dirty: false,
    });
    expect(d.patch).toContain("+TWO");
    expect(d.patch).not.toContain("new.txt");
    const m = await mgr.changedFilesManifest(w.id);
    expect(m.files).toEqual([{ path: "a.txt", status: "modified" }]);
    expect(m).toMatchObject({ includesWorkingTree: false, dirty: false });
  });

  it("includes uncommitted and untracked changes only on request, without touching the index", async () => {
    const w = await setup();
    const statusBefore = sh(w.path, "status", "--porcelain");

    const d = await mgr.diff(w.id, { includeWorkingTree: true });
    expect(d.files).toEqual([
      { path: "a.txt", status: "modified", additions: 2, deletions: 1 },
      { path: "b.txt", status: "deleted", additions: 0, deletions: 1 },
      { path: "new.txt", status: "added", additions: 2, deletions: 0 },
    ]);
    expect(d).toMatchObject({ baseSha: w.baseSha, includesWorkingTree: true, dirty: true });
    expect(d.patch).toContain("+TWO");
    expect(d.patch).toContain("+++ b/new.txt");
    expect(d.patch).not.toContain(OWNER_FILE);
    expect(sh(w.path, "status", "--porcelain")).toBe(statusBefore);

    const m = await mgr.changedFilesManifest(w.id, { includeWorkingTree: true });
    expect(m.baseSha).toBe(w.baseSha);
    expect(m.headSha).toBe(sh(w.path, "rev-parse", "HEAD"));
    expect(m.dirty).toBe(true);
    expect(m.files).toEqual([
      { path: "a.txt", status: "modified" },
      { path: "b.txt", status: "deleted" },
      { path: "new.txt", status: "added" },
    ]);
  });

  it("reports dirty: false when the working tree matches HEAD", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "c.txt", "c\n", "c");
    const d = await mgr.diff(w.id, { includeWorkingTree: true });
    expect(d).toMatchObject({ dirty: false, includesWorkingTree: true });
    expect(d.files.map((f) => f.path)).toEqual(["c.txt"]);
  });

  it("snapshots symlinks as links and never reads their targets", async () => {
    const w = await mgr.createWorktree(input());
    const outside = await dirs.make("secret");
    await writeFile(join(outside, "secret.txt"), "TOPSECRET\n");
    await symlink(join(outside, "secret.txt"), join(w.path, "leak"));
    const d = await mgr.diff(w.id, { includeWorkingTree: true });
    expect(d.files.map((f) => f.path)).toEqual(["leak"]);
    expect(d.patch).not.toContain("TOPSECRET");
    expect(d.patch).toContain("new file mode 120000");
  });

  it("returns an empty diff for an untouched worktree", async () => {
    const w = await mgr.createWorktree(input());
    expect(await mgr.diff(w.id)).toMatchObject({ files: [], patch: "" });
  });

  it("lists commits since baseSha, oldest first", async () => {
    const w = await mgr.createWorktree(input());
    expect(await mgr.commitsSince(w.id)).toEqual([]);
    const s1 = await commitFile(w.path, "x.txt", "1\n", "first change");
    const s2 = await commitFile(w.path, "x.txt", "2\n", "second change");
    const commits = await mgr.commitsSince(w.id);
    expect(commits.map((c) => [c.sha, c.subject])).toEqual([
      [s1, "first change"],
      [s2, "second change"],
    ]);
    expect(commits[0]).toMatchObject({ authorName: "Test", authorEmail: "test@example.com" });
    expect(await mgr.commitsSince(w.id, s1)).toHaveLength(1);
  });
});

describe("detectConflicts", () => {
  it("finds a real conflict without touching the worktree", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "a.txt", "one\nBRANCH\nthree\n", "branch edit");
    await commitFile(repo, "a.txt", "one\nMAIN\nthree\n", "main edit");
    const head = sh(w.path, "rev-parse", "HEAD");
    await writeFile(join(w.path, "wip.txt"), "uncommitted\n");
    const status = sh(w.path, "status", "--porcelain");

    const r = await mgr.detectConflicts(w.id, "main");
    expect(r).toMatchObject({ clean: false, conflicts: ["a.txt"], headSha: head });
    expect(r.targetSha).toBe(sh(repo, "rev-parse", "main"));
    expect(sh(w.path, "rev-parse", "HEAD")).toBe(head);
    expect(sh(w.path, "status", "--porcelain")).toBe(status);
    expect(sh(repo, "status", "--porcelain")).toBe("");
    // Dry run: the record is not mutated.
    expect(mgr.get(w.id)).toEqual(w);
  });

  it("reports no conflicts when the merge is clean", async () => {
    const w = await mgr.createWorktree(input());
    await commitFile(w.path, "c.txt", "c\n", "branch adds c");
    await commitFile(repo, "b.txt", "bee2\n", "main edits b");
    const r = await mgr.detectConflicts(w.id, "main");
    expect(r).toMatchObject({ clean: true, conflicts: [] });
    expect(mgr.get(w.id)?.status).toBe("active");
  });

  it("rejects option-like or unknown target refs", async () => {
    const w = await mgr.createWorktree(input());
    await expect(mgr.detectConflicts(w.id, "--help")).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(mgr.detectConflicts(w.id, "no-such-branch")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("restore after restart", () => {
  it("re-validates persisted records and fails closed for unknown tasks", async () => {
    const w = await mgr.createWorktree(input());
    const s1 = newId("ses");
    await mgr.claim(w.path, s1);
    await commitFile(w.path, "x.txt", "x\n", "work");

    const fresh = new GitManager({ worktreeRoot: root });
    // Before restore: an unknown task is treated as live, so no takeover.
    await expect(
      fresh.claim(w.path, newId("ses"), { taskId: newId("tsk") as TaskId }),
    ).rejects.toMatchObject({ code: "conflict" });

    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([w]);
    expect(res.restored.map((r) => r.id)).toEqual([w.id]);
    expect(res.rejected).toEqual([]);
    expect(fresh.get(w.id)).toEqual(w);
    expect((await fresh.diff(w.id)).files.map((f) => f.path)).toEqual(["x.txt"]);
    await expect(
      fresh.claim(w.path, newId("ses"), { taskId: newId("tsk") as TaskId }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(fresh.removeWorktree(w.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects tampered or stale records", async () => {
    const w1 = await mgr.createWorktree(input());
    const w2 = await mgr.createWorktree(input());
    const w3 = await mgr.createWorktree(input());
    const w4 = await mgr.createWorktree(input());
    await writeFile(
      join(w3.path, OWNER_FILE),
      JSON.stringify({ taskId: newId("tsk"), createdAt: new Date().toISOString() }),
    );
    sh(repo, "worktree", "remove", "--force", w4.path);
    const unregistered = newId("prj") as ProjectId;

    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([
      { ...w1, branch: "main" },
      { ...w2, path: join(root, unregistered, w2.taskId) },
      w3,
      w4,
      { ...w1, baseSha: "0".repeat(40) },
    ]);
    expect(res.restored).toEqual([]);
    expect(res.rejected).toHaveLength(5);
    expect(fresh.list()).toEqual([]);
  });

  it("rejects duplicate ids and keeps removed records as removed", async () => {
    const w = await mgr.createWorktree(input());
    await mgr.removeWorktree(w.id);
    const removed = mgr.get(w.id);
    if (!removed) throw new Error("missing");
    const fresh = new GitManager({ worktreeRoot: root });
    await fresh.registerProject({ projectId, repoPath: repo });
    const res = await fresh.restore([removed, removed]);
    expect(res.restored).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
    expect(fresh.get(w.id)?.status).toBe("removed");
  });
});

describe("runTests wrapper", () => {
  it("runs in the worktree resolved from the record", async () => {
    const w = await mgr.createWorktree(input());
    const r = await mgr.runTests(w.id, [
      process.execPath,
      "-e",
      "process.stdout.write(process.cwd())",
    ]);
    expect(r.stdout).toBe(w.path);
  });
});

describe("claim", () => {
  it("lets the first session claim and blocks a different live session", async () => {
    const w = await mgr.createWorktree(input());
    const s1 = newId("ses");
    const s2 = newId("ses");
    const c = await mgr.claim(w.path, s1);
    expect(c).toMatchObject({ taskId: w.taskId, sessionId: s1 });
    await expect(mgr.claim(w.path, s1)).resolves.toMatchObject({ sessionId: s1 });
    await expect(mgr.claim(w.path, s2)).rejects.toMatchObject({ code: "conflict" });
    const owner = JSON.parse(await readFile(join(w.path, OWNER_FILE), "utf8"));
    expect(owner.sessionId).toBe(s1);
  });

  it("allows takeover when the previous session is no longer live", async () => {
    const live = new Set<string>();
    const m = new GitManager({ worktreeRoot: root, isSessionLive: (s) => live.has(s) });
    const w = await m.createWorktree(input());
    const s1 = newId("ses");
    const s2 = newId("ses");
    await m.claim(w.path, s1);
    await expect(m.claim(w.path, s2)).resolves.toMatchObject({ sessionId: s2 });
    live.add(s2);
    await expect(m.claim(w.path, s1)).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails when the worktree is owned by another live task", async () => {
    const w = await mgr.createWorktree(input());
    await expect(
      mgr.claim(w.path, newId("ses"), { taskId: newId("tsk") as TaskId }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(mgr.claim(w.path, newId("ses"), { taskId: w.taskId })).resolves.toBeDefined();
  });

  it.each([
    ["garbage JSON", "{not json"],
    ["wrong shape", JSON.stringify({ taskId: 42, createdAt: "yesterday" })],
    ["bad task id", JSON.stringify({ taskId: "../x", createdAt: new Date().toISOString() })],
    ["empty session", JSON.stringify({ taskId: "", sessionId: "", createdAt: "x" })],
  ])("rejects an invalid claim file (%s) with conflict", async (_n, body) => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, OWNER_FILE), body);
    await expect(mgr.claim(w.path, newId("ses"))).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects paths outside the root, traversal and unmanaged paths", async () => {
    await expect(mgr.claim(repo, newId("ses"))).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(mgr.claim(`${root}/../x`, newId("ses"))).rejects.toMatchObject({
      code: "validation_failed",
    });
    const stray = join(root, "stray");
    await mkdir(stray);
    await expect(mgr.claim(stray, newId("ses"))).rejects.toMatchObject({ code: "not_found" });
    await rm(stray, { recursive: true });
  });
});

describe("verified task handoff", () => {
  it("exports a complete immutable binary-safe result that applies and reverses locally", async () => {
    const a = await mgr.createWorktree(input({ taskSlug: "local-export" }));
    const bytes = Buffer.from([0, 255, 2, 3, 0]);
    await writeFile(join(a.path, "asset.bin"), bytes);
    const result = await mgr.checkpoint(a.id);
    await writeFile(join(a.path, "asset.bin"), "unverified");
    const exported = await mgr.exportResult(projectId, repo, [a.baseSha], [result]);
    const patchFile = join(root, "result.patch");
    await writeFile(patchFile, exported.patch);
    expect(exported.resultCommit).toBe(result);
    expect(exported.baseSha).toBe(a.baseSha);
    sh(repo, "apply", "--check", patchFile);
    sh(repo, "apply", patchFile);
    expect(await readFile(join(repo, "asset.bin"))).toEqual(bytes);
    sh(repo, "apply", "--reverse", "--check", patchFile);
    sh(repo, "apply", "--reverse", patchFile);
    expect(existsSync(join(repo, "asset.bin"))).toBe(false);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("combines verified source from parallel tasks without mutating the project or including runtime artifacts", async () => {
    const a = await mgr.createWorktree(input({ taskSlug: "backend" }));
    const b = await mgr.createWorktree(input({ taskSlug: "frontend" }));
    await writeFile(join(a.path, "backend.txt"), "backend result\n");
    await mkdir(join(a.path, ".mimir/artifacts"), { recursive: true });
    await writeFile(join(a.path, ".mimir/artifacts/review.json"), "{}");
    await writeFile(join(b.path, "frontend.txt"), "frontend result\n");
    const original = sh(repo, "rev-parse", "HEAD");
    const resultA = await mgr.checkpoint(a.id);
    const resultB = await mgr.checkpoint(b.id);
    // Later edits cannot silently change the dependency result.
    await writeFile(join(a.path, "backend.txt"), "unverified edit\n");
    const baseRef = await mgr.dependencyBase(projectId, repo, [resultA, resultB]);
    const review = await mgr.createWorktree(input({ taskSlug: "review", baseRef: baseRef! }));
    expect(await readFile(join(review.path, "backend.txt"), "utf8")).toBe("backend result\n");
    expect(await readFile(join(review.path, "frontend.txt"), "utf8")).toBe("frontend result\n");
    expect(existsSync(join(review.path, ".mimir/artifacts/review.json"))).toBe(false);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(original);
    expect(existsSync(join(repo, "backend.txt"))).toBe(false);
  });

  it("refuses conflicting or missing dependency results", async () => {
    const a = await mgr.createWorktree(input({ taskSlug: "one" }));
    const b = await mgr.createWorktree(input({ taskSlug: "two" }));
    await writeFile(join(a.path, "a.txt"), "first change\n");
    await writeFile(join(b.path, "a.txt"), "conflicting change\n");
    const resultA = await mgr.checkpoint(a.id);
    const resultB = await mgr.checkpoint(b.id);
    await expect(mgr.dependencyBase(projectId, repo, [resultA, resultB])).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(mgr.dependencyBase(projectId, repo, ["0".repeat(40)])).rejects.toThrow();
    await expect(mgr.dependencyBase(projectId, repo, [])).resolves.toBeUndefined();
  });
});
