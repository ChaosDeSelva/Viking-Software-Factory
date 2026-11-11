import { execFileSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, makeRepo, sh } from "../test/helpers.js";
import { GitManager, type CreateWorktreeInput } from "./manager.js";

const dirs = new TempDirs();
let repo: string;
let mgr: GitManager;
let projectId: ProjectId;

function input(over: Partial<CreateWorktreeInput> = {}): CreateWorktreeInput {
  return {
    projectId,
    repoPath: repo,
    taskId: newId("tsk") as TaskId,
    crewSlug: "core",
    taskSlug: "snap",
    ...over,
  };
}

beforeEach(async () => {
  repo = await makeRepo(dirs);
  projectId = newId("prj") as ProjectId;
  mgr = new GitManager({ worktreeRoot: await dirs.make("root") });
});
afterEach(async () => {
  await dirs.cleanup();
});

const filesAt = (sha: string) => sh(repo, "ls-tree", "-r", "--name-only", sha).split("\n");

describe("checkpoint snapshots unusual working-tree entries", () => {
  it("a tracked file replaced by a FIFO is recorded as deleted", async () => {
    const w = await mgr.createWorktree(input());
    await rm(join(w.path, "b.txt"));
    execFileSync("mkfifo", [join(w.path, "b.txt")]);
    const sha = await mgr.checkpoint(w.id);
    expect(filesAt(sha)).toEqual(["a.txt"]);
  });

  it("a tracked file replaced by a directory is recorded as deleted, its contents added", async () => {
    const w = await mgr.createWorktree(input());
    await rm(join(w.path, "b.txt"));
    await mkdir(join(w.path, "b.txt"));
    await writeFile(join(w.path, "b.txt", "inner.txt"), "inner\n");
    const sha = await mgr.checkpoint(w.id);
    expect(filesAt(sha)).toEqual(["a.txt", "b.txt/inner.txt"]);
  });

  it("an unreadable file stops the checkpoint instead of being dropped", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "secret.txt"), "x\n");
    await chmod(join(w.path, "secret.txt"), 0o000);
    try {
      await expect(mgr.checkpoint(w.id)).rejects.toMatchObject({
        code: "policy_denied",
        details: expect.objectContaining({ paths: ["secret.txt"] }),
      });
    } finally {
      await chmod(join(w.path, "secret.txt"), 0o600);
    }
  });

  it("an executable file keeps its mode", async () => {
    const w = await mgr.createWorktree(input());
    await writeFile(join(w.path, "run.sh"), "#!/bin/sh\n");
    await chmod(join(w.path, "run.sh"), 0o755);
    const sha = await mgr.checkpoint(w.id);
    expect(sh(repo, "ls-tree", sha, "run.sh")).toMatch(/^100755 blob /);
  });
});
