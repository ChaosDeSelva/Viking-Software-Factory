import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, makeRepo, sh } from "../test/helpers.js";
import { ScratchRepo } from "./scratch.js";

const dirs = new TempDirs();
let repo: string;
let scratchRoot: string;

beforeEach(async () => {
  repo = await makeRepo(dirs);
  scratchRoot = join(await dirs.make("scratch"), "s");
});

afterEach(async () => {
  await dirs.cleanup();
});

describe("ScratchRepo.open", () => {
  it("serves a later open of the same directory after an earlier one failed", async () => {
    const notARepo = await dirs.make("plain");
    const [first, second] = await Promise.allSettled([
      ScratchRepo.open(scratchRoot, "p", notARepo),
      ScratchRepo.open(scratchRoot, "p", repo),
    ]);
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { gitDir: join(scratchRoot, "p.git") },
    });
  });

  it("borrows objects from the common dir of a project that is a linked worktree", async () => {
    const linked = join(await dirs.make("linked"), "checkout");
    sh(repo, "worktree", "add", "-q", "-b", "side", linked);
    const scratch = await ScratchRepo.open(scratchRoot, "p", linked);
    const head = sh(repo, "rev-parse", "HEAD");
    expect((await scratch.treeEntries(head)).has("a.txt")).toBe(true);
  });
});

describe("ScratchRepo.snapshot", () => {
  async function scratchAt(head: string) {
    const scratch = await ScratchRepo.open(scratchRoot, "p", repo);
    return { scratch, head };
  }

  it("snapshots nested paths and treats a vanished or file-replaced directory as deletions", async () => {
    await mkdir(join(repo, "sub"));
    await mkdir(join(repo, "gone"));
    await writeFile(join(repo, "sub", "x.txt"), "x\n");
    await writeFile(join(repo, "gone", "y.txt"), "y\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "nested");
    const { scratch, head } = await scratchAt(sh(repo, "rev-parse", "HEAD"));

    await writeFile(join(repo, "sub", "x.txt"), "changed\n");
    await rm(join(repo, "gone"), { recursive: true });
    let snap = await scratch.snapshot(repo, head, ["sub/x.txt", "gone/y.txt"], new Set());
    expect(snap.changed).toEqual(["gone/y.txt", "sub/x.txt"]);

    await rm(join(repo, "sub"), { recursive: true });
    await writeFile(join(repo, "sub"), "now a file\n");
    snap = await scratch.snapshot(repo, head, ["sub", "sub/x.txt"], new Set());
    expect(snap.changed).toEqual(["sub", "sub/x.txt"]);
    const tree = (await scratch.run(["ls-tree", "-r", "--name-only", snap.tree])).stdout;
    expect(tree.split("\n")).toContain("sub");
    expect(tree.split("\n")).not.toContain("sub/x.txt");
  });

  it("keeps HEAD's gitlink entry without reading the nested checkout", async () => {
    const blob = sh(repo, "rev-parse", "HEAD");
    sh(repo, "update-index", "--add", "--cacheinfo", `160000,${blob},vendor`);
    sh(repo, "commit", "-q", "-m", "gitlink");
    const { scratch, head } = await scratchAt(sh(repo, "rev-parse", "HEAD"));
    await mkdir(join(repo, "vendor"), { recursive: true });
    await writeFile(join(repo, "vendor", "planted.txt"), "x\n");
    const snap = await scratch.snapshot(repo, head, ["vendor"], new Set());
    expect(snap).toEqual({ tree: sh(repo, "rev-parse", "HEAD^{tree}"), changed: [] });
  });
});
