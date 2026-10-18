import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitManager } from "@mimir/git";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreePort, type PersistedWorktree } from "./git-port.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_DIR: undefined } });

function makeRepo(): string {
  const repo = tempDir("mimir-port-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GitWorktreePort.restore", () => {
  it("re-adopts persisted worktrees into a fresh GitManager after a restart", async () => {
    const repo = makeRepo();
    const root = tempDir("mimir-port-root-");
    const projectId = newId("prj") as ProjectId;
    const before = new GitWorktreePort(new GitManager({ worktreeRoot: root }));
    const worktree = await before.create({
      projectId,
      repoPath: repo,
      taskId: newId("tsk") as TaskId,
      crewSlug: "core",
      taskSlug: "restore",
    });

    const after = new GitWorktreePort(new GitManager({ worktreeRoot: root }));
    expect(after.has(worktree.id)).toBe(false);
    const records: PersistedWorktree[] = [{ worktree, projectId, repoPath: repo }];
    const result = await after.restore(records);

    expect(result).toEqual({ restored: 1, rejected: [] });
    expect(after.has(worktree.id)).toBe(true);
    writeFileSync(join(worktree.path, "a.txt"), "edited without a commit\n");
    const diff = await after.diff(worktree.id);
    expect(diff.dirty).toBe(true);
    expect(diff.patch).toContain("+edited without a commit");
  }, 120_000);

  it("reports a record whose worktree no longer exists as rejected, with a reason", async () => {
    const repo = makeRepo();
    const root = tempDir("mimir-port-root-");
    const projectId = newId("prj") as ProjectId;
    const before = new GitWorktreePort(new GitManager({ worktreeRoot: root }));
    const worktree = await before.create({
      projectId,
      repoPath: repo,
      taskId: newId("tsk") as TaskId,
      crewSlug: "core",
      taskSlug: "gone",
    });
    git(repo, "worktree", "remove", "--force", worktree.path);

    const after = new GitWorktreePort(new GitManager({ worktreeRoot: root }));
    const result = await after.restore([{ worktree, projectId, repoPath: repo }]);

    expect(result.restored).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.worktreeId).toBe(worktree.id);
    expect(result.rejected[0]?.reason).toMatch(/\S/);
    expect(after.has(worktree.id)).toBe(false);
  }, 120_000);
});
