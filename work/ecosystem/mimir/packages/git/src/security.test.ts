import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type ProjectId, type TaskId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, commitFile, makeRepo, sh } from "../test/helpers.js";
import { gitEnv } from "./git.js";
import { GitManager, type CreateWorktreeInput } from "./manager.js";

/**
 * Reproduces review finding C1: agent-controlled repo config and attributes name a driver
 * command. A Mimir git call must never execute it, and the canary secret in Mimir's env must
 * never reach it. The driver appends "<kind>:<canary>" to a sentinel file.
 */
const CANARY = "canary-7f3e-hunter2";
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
    taskSlug: "sec",
    ...over,
  };
}

type Kind = "filter" | "merge" | "textconv" | "diffcmd" | "gpg";

/** Plants a driver of `kind` in the repo's local config plus info/attributes. */
async function plant(kind: Kind): Promise<void> {
  const cfg = (k: string, v: string) => sh(repo, "config", "--local", k, v);
  switch (kind) {
    case "filter":
      cfg("filter.evil.clean", `${driver} clean`);
      cfg("filter.evil.smudge", `${driver} smudge`);
      break;
    case "merge":
      cfg("merge.evil.driver", `${driver} merge %A`);
      break;
    case "textconv":
      cfg("diff.evil.textconv", `${driver} textconv`);
      break;
    case "diffcmd":
      cfg("diff.evil.command", `${driver} diffcmd`);
      break;
    case "gpg":
      cfg("gpg.program", `${driver}`);
      cfg("log.showSignature", "true");
      break;
  }
  const commonDir = join(repo, ".git");
  await writeFile(join(commonDir, "info", "attributes"), "* filter=evil merge=evil diff=evil\n");
}

async function sentinelText(): Promise<string> {
  return existsSync(sentinel) ? await readFile(sentinel, "utf8") : "";
}

beforeEach(async () => {
  process.env.MIMIR_CANARY = CANARY;
  repo = await makeRepo(dirs);
  root = await dirs.make("root");
  const tools = await dirs.make("tools");
  sentinel = join(tools, "sentinel.txt");
  driver = join(tools, "driver.sh");
  await writeFile(
    driver,
    `#!/bin/sh\necho "$1:$MIMIR_CANARY" >> '${sentinel}'\ncat 2>/dev/null\nexit 0\n`,
  );
  await chmod(driver, 0o755);
  projectId = newId("prj") as ProjectId;
  mgr = new GitManager({ worktreeRoot: root });
});

afterEach(async () => {
  delete process.env.MIMIR_CANARY;
  await dirs.cleanup();
});

describe("C1 harness control", () => {
  it("a raw git call with the inherited env does run the planted filter (proves the harness)", async () => {
    await plant("filter");
    await writeFile(join(repo, "a.txt"), "changed\n");
    sh(repo, "add", "-A");
    expect(await sentinelText()).toContain(`clean:${CANARY}`);
  });
});

describe("gitEnv", () => {
  it("is an allowlist and never carries the parent env", () => {
    const env = gitEnv({ GIT_INDEX_FILE: "/x" });
    expect(Object.values(env)).not.toContain(CANARY);
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: "/x",
    });
    const allowed = new Set([
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TERM",
      "TMPDIR",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_ATTR_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "GIT_OPTIONAL_LOCKS",
      "GIT_INDEX_FILE",
    ]);
    expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
  });
});

describe("C1 config audit before worktree add/remove", () => {
  it.each([
    ["filter.evil.clean", "x"],
    ["merge.evil.driver", "x"],
    ["diff.evil.command", "x"],
    ["diff.evil.textconv", "x"],
    ["core.sshCommand", "x"],
    ["core.gitProxy", "x"],
    ["credential.helper", "x"],
    ["core.fsmonitor", "x"],
    ["core.hooksPath", "/nonexistent/hooks"],
    ["gpg.program", "x"],
    ["alias.st", "status"],
    ["include.path", "/nonexistent/mimir-include"],
    ["includeIf.gitdir:/x/.path", "/nonexistent/mimir-include"],
  ])("createWorktree fails closed with policy_denied when %s is set", async (key, value) => {
    sh(repo, "config", "--local", key, value);
    const err = await mgr.createWorktree(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "policy_denied",
      details: { keys: [key.toLowerCase()] },
    });
    expect(sh(repo, "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
  });

  it("a smudge filter planted by an earlier task never runs on createWorktree", async () => {
    await plant("filter");
    await expect(mgr.createWorktree(input())).rejects.toMatchObject({ code: "policy_denied" });
    expect(await sentinelText()).toBe("");
  });

  it("removeWorktree fails closed (even forced) when drivers were planted", async () => {
    const w = await mgr.createWorktree(input());
    await plant("filter");
    await writeFile(join(w.path, "a.txt"), "dirty\n");
    await expect(mgr.removeWorktree(w.id)).rejects.toMatchObject({ code: "policy_denied" });
    await expect(
      mgr.removeWorktree(w.id, { force: true, approvalId: newId("apr") }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    expect(existsSync(w.path)).toBe(true);
    expect(await sentinelText()).toBe("");
  });
});

describe("C1 read-only analysis never executes agent drivers", () => {
  it.each<Kind>(["filter", "merge", "textconv", "diffcmd", "gpg"])(
    "%s driver: diff, manifest, commitsSince and detectConflicts stay inert",
    async (kind) => {
      const w = await mgr.createWorktree(input());
      await commitFile(w.path, "a.txt", "one\nBRANCH\nthree\n", "branch edit");
      await commitFile(repo, "a.txt", "one\nMAIN\nthree\n", "main edit");
      // A commit carrying a forged signature so `log` would consult gpg.program.
      const tree = sh(w.path, "rev-parse", "HEAD^{tree}");
      const parent = sh(w.path, "rev-parse", "HEAD");
      const body =
        `tree ${tree}\nparent ${parent}\nauthor T <t@e> 1700000000 +0000\n` +
        `committer T <t@e> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n` +
        ` AAAA\n -----END PGP SIGNATURE-----\n\nsigned\n`;
      const signed = execHashCommit(w.path, body);
      sh(w.path, "update-ref", `refs/heads/${w.branch}`, signed);

      await plant(kind);
      await writeFile(join(w.path, "b.txt"), "bee changed\n");
      await writeFile(join(w.path, "untracked.txt"), "u\n");

      const committed = await mgr.diff(w.id);
      expect(committed.files.map((f) => f.path)).toEqual(["a.txt"]);
      const full = await mgr.diff(w.id, { includeWorkingTree: true });
      expect(full.files.map((f) => f.path)).toEqual(["a.txt", "b.txt", "untracked.txt"]);
      await mgr.changedFilesManifest(w.id, { includeWorkingTree: true });
      const commits = await mgr.commitsSince(w.id);
      expect(commits.map((c) => c.subject)).toEqual(["branch edit", "signed"]);
      const conflicts = await mgr.detectConflicts(w.id, "main");
      expect(conflicts).toMatchObject({ clean: false, conflicts: ["a.txt"] });

      expect(await sentinelText()).toBe("");
    },
  );
});

function execHashCommit(cwd: string, body: string): string {
  return execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd,
    input: body,
    encoding: "utf8",
  }).trim();
}
