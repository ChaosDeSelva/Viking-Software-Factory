import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangedHunks, type PrReviewView } from "@sindri/delivery";
import type { ExecFn } from "@sindri/intake";
import { applyMigrations, openDatabase, openKnowledge } from "@sindri/knowledge";
import { createTempRepo } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedRemoteLookup,
  githubReposOf,
  MIRROR_GIT_CONFIG,
  MIRROR_LOCAL_CONFIG,
  ReviewMirror,
} from "./review-mirror.js";
import { SERVER_MIGRATIONS } from "./schema.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PR: PrReviewView = {
  owner: "Acme",
  repo: "widgets",
  number: 7,
  url: "https://github.com/Acme/widgets/pull/7",
  title: "t",
  body: "",
  author: null,
  baseRef: "main",
  headRef: "f",
  baseSha: BASE,
  headSha: HEAD,
  isCrossRepository: false,
  files: [],
  filesOmitted: 0,
  nonce: "abc123",
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A mirror whose git calls are recorded; `fail` decides which ones fail. */
function setup(
  fail: (args: readonly string[], n: number) => boolean = () => false,
  clock: { now: Date } = { now: new Date("2026-11-01T00:00:00Z") },
) {
  dir = mkdtempSync(join(tmpdir(), "sindri-mirror-test-"));
  const db = openDatabase(":memory:");
  const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
  applyMigrations(db, "server", SERVER_MIGRATIONS);
  const calls: { file: string; args: string[]; cwd: string | undefined; input?: string }[] = [];
  const answers: Record<string, string> = {};
  const config = new Map<string, string>();
  const exec: ExecFn = async (file, args, opts) => {
    const own = args.slice(MIRROR_GIT_CONFIG.length);
    calls.push({
      file,
      args: own,
      cwd: opts?.cwd,
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
    const answer = answers[own.slice(0, 2).join(" ")];
    if (answer !== undefined && !fail(own, calls.length)) return { stdout: answer, stderr: "" };
    expect(args.slice(0, MIRROR_GIT_CONFIG.length)).toEqual(MIRROR_GIT_CONFIG);
    if (own[0] === "clone") mkdirSync(join(own.at(-1)!, ".git"), { recursive: true });
    if (own[0] === "config" && own[2] === "--replace-all") config.set(own[3]!, own[4]!);
    if (own[0] === "config" && own[2] === "--get") {
      const v = config.get(own[3]!);
      if (v === undefined) throw new Error("unset");
      return { stdout: `${v}\n`, stderr: "" };
    }
    if (fail(own, calls.length)) throw new Error("git failed");
    return { stdout: own[0] === "diff" ? "diff --git a/x b/x\n" : "", stderr: "" };
  };
  const mirror = new ReviewMirror({ db, dataDir: dir, exec, now: () => clock.now });
  /** The calls other than config and ref bookkeeping. */
  const work = () =>
    calls.filter((c) => !["config", "update-ref"].includes(c.args[0]!)).map((c) => c.args);
  return { mirror, calls, projectId, config, work, clock, answers };
}

describe("ReviewMirror", () => {
  it("clones once without checkout, fetches both commits, verifies them and checks out the head", async () => {
    let fetched = false;
    const { mirror, calls, projectId, work } = setup((args) => {
      if (args[0] === "fetch") fetched = true;
      return args[0] === "cat-file" && !fetched;
    });
    const rec = await mirror.prepare(projectId, PR);
    const path = join(dir, "review-mirrors", projectId);
    expect(rec).toEqual({ projectId, repo: "acme/widgets", path, mimirProjectId: null });
    expect(work()).toEqual([
      [
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        "--",
        "https://github.com/acme/widgets.git",
        path,
      ],
      ["cat-file", "-e", `${BASE}^{commit}`],
      ["fetch", "--no-tags", "origin", BASE, HEAD],
      ["cat-file", "-e", `${BASE}^{commit}`],
      ["cat-file", "-e", `${HEAD}^{commit}`],
      ["checkout", "--detach", "--force", HEAD],
      ["diff", "--no-ext-diff", "--binary", "--output=/dev/null", `${BASE}...${HEAD}`],
      ["diff", "--raw", "--no-abbrev", "-z", `${BASE}...${HEAD}`],
      ["rev-list", "--objects", "--missing=print", "--no-walk", "--stdin"],
    ]);
    expect(calls.slice(1).every((c) => c.cwd === path)).toBe(true);
    // Reused: no second clone, no fetch when both commits are there.
    expect(calls.filter((c) => c.args[0] === "update-ref").map((c) => c.args)).toEqual([
      ["update-ref", "refs/sindri/pr/7/head", HEAD],
      ["update-ref", "refs/sindri/pr/7/base", BASE],
    ]);
    calls.length = 0;
    await mirror.prepare(projectId, PR);
    expect(work().map((a) => a[0])).toEqual([
      "cat-file",
      "cat-file",
      "checkout",
      "diff",
      "diff",
      "rev-list",
    ]);
    mirror.setMimirProject(projectId, "prj_m");
    expect(mirror.get(projectId)?.mimirProjectId).toBe("prj_m");
  });

  it("falls back to the PR ref when the SHAs cannot be fetched", async () => {
    let fetches = 0;
    const { mirror, calls, projectId } = setup((args) => {
      if (args[0] === "fetch") fetches++;
      if (args[0] === "fetch") return fetches === 1;
      return args[0] === "cat-file" && fetches < 2;
    });
    await mirror.prepare(projectId, PR);
    expect(calls.filter((c) => c.args[0] === "fetch").map((c) => c.args)).toEqual([
      ["fetch", "--no-tags", "origin", BASE, HEAD],
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/pull/7/head:refs/sindri/pr/7/head",
        "+refs/heads/main:refs/sindri/pr/7/base-branch",
      ],
    ]);
  });

  it("writes the mirror's own git config once: gh credentials only, no hooks or submodules", async () => {
    const { mirror, calls, projectId, config } = setup();
    await mirror.prepare(projectId, PR);
    const writes = calls
      .filter((c) => c.args[0] === "config" && c.args[2] === "--replace-all")
      .map((c) => c.args.slice(3));
    expect(writes).toEqual(MIRROR_LOCAL_CONFIG.map(([k, v]) => [k, v]));
    // Inherited helpers are reset before gh's is added.
    expect(writes[0]).toEqual(["credential.helper", ""]);
    expect(writes[1]).toEqual(["credential.https://github.com.helper", "!gh auth git-credential"]);
    expect(config.get("fetch.recurseSubmodules")).toBe("false");
    expect(config.get("core.hooksPath")).toBe("/dev/null");
    calls.length = 0;
    await mirror.prepare(projectId, PR);
    expect(calls.filter((c) => c.args[2] === "--replace-all")).toHaveLength(0);
    // A new config version rewrites it.
    config.set("sindri.mirrorConfig", "0");
    await mirror.prepare(projectId, PR);
    expect(calls.filter((c) => c.args[2] === "--replace-all")).toHaveLength(
      MIRROR_LOCAL_CONFIG.length,
    );
  });

  it("prunes the refs of PRs fetched over 30 days ago and beyond the newest 20", async () => {
    const { mirror, calls, projectId, clock } = setup();
    const deleted = () =>
      calls.filter((c) => c.args[0] === "update-ref" && c.args[1] === "-d").map((c) => c.args[2]);
    const start = Date.parse("2026-09-01T00:00:00Z");
    // PR 1 fetched long ago, then 21 more PRs a day apart.
    clock.now = new Date(start);
    await mirror.prepare(projectId, { ...PR, number: 1 });
    clock.now = new Date(start + 40 * 86_400_000);
    await mirror.prepare(projectId, { ...PR, number: 2 });
    expect(deleted()).toEqual([
      "refs/sindri/pr/1/head",
      "refs/sindri/pr/1/base",
      "refs/sindri/pr/1/base-branch",
    ]);
    calls.length = 0;
    for (let n = 3; n <= 22; n++) {
      clock.now = new Date(start + (40 + n) * 86_400_000);
      await mirror.prepare(projectId, { ...PR, number: n });
    }
    // 21 PRs (2..22): the oldest, PR 2, goes.
    expect(deleted()).toEqual([
      "refs/sindri/pr/2/head",
      "refs/sindri/pr/2/base",
      "refs/sindri/pr/2/base-branch",
    ]);
  });

  it("checks, without fetching, that both sides of every changed file and the head are present", async () => {
    const OLD = "1".repeat(40);
    const NEW = "2".repeat(40);
    const ADDED = "3".repeat(40);
    const ZERO = "0".repeat(40);
    const { mirror, calls, projectId, answers } = setup();
    answers["diff --raw"] = [
      `:100644 100644 ${OLD} ${NEW} M`,
      "src/a.ts",
      `:000000 100644 ${ZERO} ${ADDED} A`,
      "src/new file.ts",
      "",
    ].join("\0");
    answers["rev-list --objects"] = `${HEAD}\n${OLD} src/a.ts\n`;
    await mirror.prepare(projectId, PR);
    const check = calls.find((c) => c.args[0] === "rev-list")!;
    expect(check.input).toBe(`${HEAD}\n${OLD}\n${NEW}\n${ADDED}\n`);

    answers["rev-list --objects"] = `${HEAD}\n?${NEW}\n?${ADDED}\n`;
    await expect(mirror.prepare(projectId, PR)).rejects.toMatchObject({
      reason: "blobs_missing",
      message: expect.stringContaining("2 file version"),
    });
  });

  it("fails when a commit is still missing after fetching", async () => {
    const { mirror, projectId } = setup((args) => args[0] === "cat-file");
    await expect(mirror.prepare(projectId, PR)).rejects.toMatchObject({ reason: "commit_missing" });
  });

  it("refuses malformed commits and serializes work per project", async () => {
    const { mirror, calls, projectId, answers } = setup();
    await expect(mirror.prepare(projectId, { ...PR, headSha: "nope" })).rejects.toMatchObject({
      reason: "invalid_pr",
    });
    await Promise.all([mirror.prepare(projectId, PR), mirror.prepare(projectId, PR)]);
    expect(calls.filter((c) => c.args[0] === "clone")).toHaveLength(1);
    answers["merge-base " + BASE] = `${"c".repeat(40)}\n`;
    expect(await mirror.diff(projectId, PR)).toEqual({
      diff: expect.stringContaining("diff --git"),
      mergeBaseSha: "c".repeat(40),
    });
    expect(calls.slice(-2).map((c) => c.args)).toEqual([
      ["merge-base", BASE, HEAD],
      ["diff", "--unified=0", "--no-color", "--no-ext-diff", `${BASE}...${HEAD}`, "--"],
    ]);
  });
});

describe("ReviewMirror.diff on a real repository", () => {
  it("diffs against the merge base when the base branch moved on after branching", async () => {
    const repo = createTempRepo(
      { "a.ts": Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" },
      { git: true },
    );
    dir = mkdtempSync(join(tmpdir(), "sindri-mirror-real-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
          cwd: repo.path,
          encoding: "utf8",
        }).trim();
      git("add", ".");
      git("commit", "-qm", "init");
      const fork = git("rev-parse", "HEAD");
      const edit = (line: number, text: string) => {
        const lines = readFileSync(join(repo.path, "a.ts"), "utf8").split("\n");
        lines[line - 1] = text;
        writeFileSync(join(repo.path, "a.ts"), lines.join("\n"));
      };
      // The PR changes line 5.
      git("checkout", "-q", "-b", "feature");
      edit(5, "feature line 5");
      git("commit", "-qam", "feature");
      const head = git("rev-parse", "HEAD");
      // The base branch moves on: line 15 and a new file.
      git("checkout", "-q", fork);
      edit(15, "main line 15");
      writeFileSync(join(repo.path, "b.ts"), "b\n");
      git("add", ".");
      git("commit", "-qm", "main");
      const base = git("rev-parse", "HEAD");

      const db = openDatabase(":memory:");
      const projectId = openKnowledge(db).projects.create({ name: "p", repoPath: "/tmp/p" }).id;
      applyMigrations(db, "server", SERVER_MIGRATIONS);
      db.prepare(
        `INSERT INTO review_mirrors (project_id, repo, path, created_at, updated_at)
         VALUES (?, 'acme/widgets', ?, 't', 't')`,
      ).run(projectId, repo.path);
      const mirror = new ReviewMirror({ db, dataDir: dir });
      const { diff, mergeBaseSha } = await mirror.diff(projectId, {
        ...PR,
        baseSha: base,
        headSha: head,
      });
      expect(mergeBaseSha).toBe(fork);
      const hunks = parseChangedHunks(diff);
      expect([...hunks.paths]).toEqual(["a.ts"]);
      expect(hunks.right.get("a.ts")).toEqual([{ start: 5, end: 5 }]);
      // LEFT lines are merge-base lines: line 5 there, not the base branch's line 15.
      expect(hunks.left.get("a.ts")).toEqual([{ start: 5, end: 5 }]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("cachedRemoteLookup", () => {
  it("looks up concurrently with a cap and caches for the TTL", async () => {
    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    let clock = 0;
    const reposOf = cachedRemoteLookup(
      async (path) => {
        seen.push(path);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return [`o/${path}`];
      },
      { ttlMs: 60_000, concurrency: 2, now: () => clock },
    );
    const projects = ["a", "b", "c", "d", "e"].map((p) => ({ id: p, repoPath: p }));
    const first = await reposOf(projects);
    expect(first.get("c")).toEqual(["o/c"]);
    expect(peak).toBe(2);
    expect(seen).toHaveLength(5);
    await reposOf(projects);
    expect(seen).toHaveLength(5);
    clock = 61_000;
    await reposOf(projects.slice(0, 1));
    expect(seen).toHaveLength(6);
  });
});

describe("githubReposOf", () => {
  it("lists the GitHub repositories of a checkout's remotes", async () => {
    const repo = createTempRepo({ "a.txt": "a\n" }, { git: true });
    dir = mkdtempSync(join(tmpdir(), "sindri-remotes-"));
    try {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:Acme/Widgets.git"], {
        cwd: repo.path,
      });
      execFileSync("git", ["remote", "add", "other", "https://gitlab.com/a/b.git"], {
        cwd: repo.path,
      });
      expect(await githubReposOf(repo.path)).toEqual(["acme/widgets"]);
      expect(await githubReposOf(dir)).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
