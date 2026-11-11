import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { planningWorkspace } from "./repo-snapshot.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `sindri-snapshot-${name}-`));
  roots.push(dir);
  return dir;
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** An upstream with one commit, and a clone that has moved on locally. */
function cloneWithLocalWork() {
  const upstream = temp("upstream");
  sh(upstream, "init", "-q", "-b", "main");
  writeFileSync(join(upstream, "a.txt"), "default branch\n");
  sh(upstream, "add", "-A");
  sh(upstream, "commit", "-q", "-m", "one");
  const repo = temp("repo");
  sh(repo, "clone", "-q", upstream, ".");
  sh(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "a.txt"), "feature branch, uncommitted\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  return { repo, sha: sh(repo, "rev-parse", "origin/main") };
}

it("snapshots the fetched default branch, not the working checkout", async () => {
  const { repo, sha } = cloneWithLocalWork();
  const dataDir = temp("data");
  const ws = await planningWorkspace({ dataDir, projectId: "p1", repoPath: repo });
  expect(ws.path).toBe(join(dataDir, "snapshots", "p1", sha));
  expect(ws.label).toContain("origin/main");
  expect(ws.label).toContain(sha.slice(0, 12));
  expect(readFileSync(join(ws.path, "a.txt"), "utf8")).toBe("default branch\n");
  expect(existsSync(join(ws.path, ".env"))).toBe(false);
  expect(existsSync(join(ws.path, ".git"))).toBe(false);
  // The checkout itself is left exactly as it was.
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("feature branch, uncommitted\n");
  expect(sh(repo, "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
});

it("reuses a snapshot for the same commit and replaces it when the branch moves", async () => {
  const { repo, sha } = cloneWithLocalWork();
  const dataDir = temp("data");
  const first = await planningWorkspace({ dataDir, projectId: "p1", repoPath: repo });
  writeFileSync(join(first.path, "marker"), "kept\n");
  const again = await planningWorkspace({ dataDir, projectId: "p1", repoPath: repo });
  expect(existsSync(join(again.path, "marker"))).toBe(true);

  sh(repo, "commit", "-q", "--allow-empty", "-m", "two");
  sh(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const moved = await planningWorkspace({ dataDir, projectId: "p1", repoPath: repo });
  expect(moved.path).not.toBe(first.path);
  expect(readdirSync(join(dataDir, "snapshots", "p1"))).toEqual([sh(repo, "rev-parse", "HEAD")]);
  expect(sha).not.toBe(sh(repo, "rev-parse", "HEAD"));
});

it("tolerates a husky hooks path and never runs the hook", async () => {
  const { repo } = cloneWithLocalWork();
  const hooks = temp("hooks");
  const sentinel = join(hooks, "ran");
  for (const hook of ["post-checkout", "pre-commit", "reference-transaction"])
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ran > '${sentinel}'\n`, { mode: 0o755 });
  sh(repo, "config", "--local", "core.hooksPath", hooks);
  const ws = await planningWorkspace({ dataDir: temp("data"), projectId: "p1", repoPath: repo });
  expect(ws.label).toContain("snapshot");
  expect(existsSync(sentinel)).toBe(false);
});

it("falls back to the checkout, and says so, when no snapshot can be made", async () => {
  const { repo } = cloneWithLocalWork();
  const plain = temp("plain");
  const noDataDir = await planningWorkspace({ dataDir: null, projectId: "p1", repoPath: repo });
  const notGit = await planningWorkspace({
    dataDir: temp("data"),
    projectId: "p2",
    repoPath: plain,
  });
  sh(repo, "config", "--local", "filter.evil.smudge", "false");
  const unsafe = await planningWorkspace({
    dataDir: temp("data"),
    projectId: "p3",
    repoPath: repo,
  });
  for (const [ws, path] of [
    [noDataDir, repo],
    [notGit, plain],
    [unsafe, repo],
  ] as const) {
    expect(ws.path).toBe(path);
    expect(ws.label).toContain("working checkout");
  }
});
