import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, commitFile, makeRepo, sh } from "../test/helpers.js";
import { GitManager, OWNER_FILE, type CreateWorktreeInput } from "./manager.js";

const dirs = new TempDirs();
let repo: string;
let root: string;
let sentinel: string;
let driver: string;
let projectId: ProjectId;
let mgr: GitManager;

function input(over: Partial<CreateWorktreeInput> = {}): CreateWorktreeInput {
  return {
    projectId,
    repoPath: repo,
    taskId: newId("tsk") as TaskId,
    crewSlug: "core",
    taskSlug: "hard",
    ...over,
  };
}

beforeEach(async () => {
  repo = await makeRepo(dirs);
  root = await dirs.make("root");
  const tools = await dirs.make("tools");
  sentinel = join(tools, "sentinel.txt");
  driver = join(tools, "driver.sh");
  // Exits at once: a transport helper that waited on stdin would deadlock with git.
  await writeFile(driver, `#!/bin/sh\necho "$1" >> '${sentinel}'\nexit 0\n`);
  await chmod(driver, 0o755);
  projectId = newId("prj") as ProjectId;
  mgr = new GitManager({ worktreeRoot: root });
});

afterEach(async () => {
  await dirs.cleanup();
});

describe("transports an agent can configure never run", () => {
  /** A promisor remote: git fetches any missing object from it, through `uploadpack`. */
  function plantPromisor(cwd: string) {
    sh(cwd, "config", "--local", "remote.evil.url", repo);
    sh(cwd, "config", "--local", "remote.evil.promisor", "true");
    sh(cwd, "config", "--local", "remote.evil.uploadpack", `'${driver}' lazy`);
  }
  const missing = "1".repeat(40);

  it("harness control: a plain git lookup of a missing object runs the promisor's uploadpack", () => {
    plantPromisor(repo);
    expect(() => sh(repo, "rev-parse", "--verify", "--quiet", `${missing}^{commit}`)).toThrow();
    expect(existsSync(sentinel)).toBe(true);
  });

  it("resolving an unknown commit does not lazy-fetch from a planted promisor remote", async () => {
    const w = await mgr.createWorktree(input());
    plantPromisor(repo);
    await expect(mgr.detectConflicts(w.id, missing)).rejects.toMatchObject({ code: "not_found" });
    await expect(mgr.createWorktree(input({ baseRef: missing }))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(mgr.dependencyBase(projectId, repo, [missing])).rejects.toMatchObject({
      code: "not_found",
    });
    expect(existsSync(sentinel)).toBe(false);
  });

  it("a worktree HEAD with a missing parent does not lazy-fetch on diff or removal", async () => {
    const w = await mgr.createWorktree(input());
    const tree = sh(w.path, "rev-parse", "HEAD^{tree}");
    const orphaned = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: w.path,
      input:
        `tree ${tree}\nparent ${missing}\nauthor T <t@e> 1700000000 +0000\n` +
        `committer T <t@e> 1700000000 +0000\n\norphaned\n`,
      encoding: "utf8",
    }).trim();
    sh(w.path, "update-ref", `refs/heads/${w.branch}`, orphaned);
    plantPromisor(repo);
    await expect(mgr.commitsSince(w.id)).rejects.toThrow();
    await expect(mgr.removeWorktree(w.id)).rejects.toThrow();
    expect(existsSync(sentinel)).toBe(false);
    expect(existsSync(w.path)).toBe(true);
  });

  it("the result import cannot be redirected to an ext:: command by url.*.insteadOf", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "work.txt"), "work\n");
    sh(repo, "config", "--local", "protocol.ext.allow", "always");
    sh(repo, "config", "--local", `url.ext::${driver} ext .insteadOf`, root);
    await expect(mgr.checkpoint(w.id)).rejects.toThrow();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("the result import does not recurse into a submodule's agent-writable remote", async () => {
    const sub = await dirs.make("sub");
    sh(sub, "init", "-q", "-b", "main");
    await commitFile(sub, "s.txt", "s\n", "sub");
    sh(repo, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "sub");
    sh(repo, "commit", "-q", "-m", "add submodule");
    sh(repo, "config", "--local", "fetch.recurseSubmodules", "true");
    sh(join(repo, "sub"), "config", "--local", "remote.origin.uploadpack", `'${driver}' sub`);
    const head = sh(repo, "rev-parse", "HEAD");
    await expect(mgr.dependencyBase(projectId, repo, [head])).resolves.toBe(head);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("exported patches survive JSON and a UTF-8 file", () => {
  it("a Latin-1 text file is exported so that the patch still applies byte for byte", async () => {
    const legacy = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x74, 0x77, 0x6f, 0x0a]);
    await writeFile(join(repo, "legacy.txt"), legacy);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "legacy encoding");
    const w = await mgr.createWorktree(input());
    const edited = Buffer.concat([legacy, Buffer.from([0x6e, 0x69, 0xf1, 0x6f, 0x0a])]);
    await writeFile(join(w.path, "legacy.txt"), edited);
    await writeFile(join(w.path, "added.txt"), Buffer.from([0xfc, 0x62, 0x65, 0x72, 0x0a]));
    await writeFile(join(w.path, "plain.txt"), "plain utf-8 ✓\n");
    const result = await mgr.checkpoint(w.id);
    const exported = await mgr.exportResult(projectId, repo, [w.baseSha], [result]);

    // The server stores the export as JSON and the operator saves `patch` as a UTF-8 file.
    const patch = (JSON.parse(JSON.stringify(exported)) as { patch: string }).patch;
    const patchFile = join(root, "legacy.patch");
    await writeFile(patchFile, patch);
    sh(repo, "apply", "--check", patchFile);
    sh(repo, "apply", patchFile);
    expect(await readFile(join(repo, "legacy.txt"))).toEqual(edited);
    expect(await readFile(join(repo, "added.txt"))).toEqual(
      Buffer.from([0xfc, 0x62, 0x65, 0x72, 0x0a]),
    );
    expect(await readFile(join(repo, "plain.txt"), "utf8")).toBe("plain utf-8 ✓\n");
    // Files that are valid UTF-8 stay readable in the patch.
    expect(patch).toContain("+plain utf-8 ✓");
  });
});

describe("commitsSince", () => {
  it("returns one entry per commit even when a subject carries a record separator", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "x.txt"), "x\n");
    sh(w.path, "add", "-A");
    sh(w.path, "commit", "-q", "-m", `legit\x1e${"f".repeat(40)}`);
    const head = sh(w.path, "rev-parse", "HEAD");
    const commits = await mgr.commitsSince(w.id);
    expect(commits.map((c) => c.sha)).toEqual([head]);
    expect(commits[0]).toMatchObject({ authorName: "Test", authorEmail: "test@example.com" });
    expect(commits[0]?.subject).toContain("legit");
  });
});

describe("createWorktree cleans up after a failure", () => {
  it("leaves no worktree or branch behind when the owner file cannot be written", async () => {
    // A repository that tracks a file at the claim path: the exclusive create fails.
    await commitFile(repo, OWNER_FILE, "{}\n", "track the claim path");
    const taskId = newId("tsk") as TaskId;
    await expect(mgr.createWorktree(input({ taskId }))).rejects.toThrow();
    expect(existsSync(join(root, projectId, taskId))).toBe(false);
    expect(sh(repo, "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
    expect(sh(repo, "branch", "--list", "mimir/*")).toBe("");
    expect(mgr.list()).toEqual([]);
  });
});

describe("concurrent use of a fresh worktree root", () => {
  it("combines dependencies from several callers at once", async () => {
    sh(repo, "checkout", "-q", "-b", "left");
    const left = await commitFile(repo, "left.txt", "left\n", "left");
    sh(repo, "checkout", "-q", "-b", "right", "main");
    const right = await commitFile(repo, "right.txt", "right\n", "right");
    sh(repo, "checkout", "-q", "main");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => mgr.dependencyBase(projectId, repo, [left, right])),
    );
    expect(new Set(results).size).toBe(1);
    expect(sh(repo, "rev-parse", `${results[0]}^1`, `${results[0]}^2`).split("\n").sort()).toEqual(
      [left, right].sort(),
    );
  });
});
