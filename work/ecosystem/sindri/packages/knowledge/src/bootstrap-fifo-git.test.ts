import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";

// Review Ssec I1: a FIFO on any path git reads stalled bootstrap (and the server event loop)
// for 60 s. Ruling: bootstrap always lists with the walker; git is never spawned for listing.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env["PATH"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

function initRepo(dir: string) {
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Repo\n\nplain readme\n");
  writeFileSync(join(dir, "docs/guide.md"), "# Guide\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
}

const fifo = (p: string) => {
  rmSync(p, { force: true });
  execFileSync("mkfifo", [p]);
};

describe("bootstrapProject: FIFOs on paths git would read", { timeout: 30_000 }, () => {
  let scratch: string;
  let repo: string;
  let k: Knowledge;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "sindri-fifo-git-"));
    repo = join(scratch, "repo");
    initRepo(repo);
    k = openKnowledge(":memory:");
  });
  afterEach(() => {
    k.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const timedBootstrap = () => {
    const id = k.projects.create({ name: "r", repoPath: repo }).id;
    const t0 = performance.now();
    const res = k.bootstrapProject(id, { repoPath: repo });
    return { res, ms: performance.now() - t0 };
  };

  it.each([
    ["the git index", () => fifo(join(repo, ".git/index"))],
    ["HEAD", () => fifo(join(repo, ".git/HEAD"))],
    ["info/exclude", () => fifo(join(repo, ".git/info/exclude"))],
    ["the root .gitignore", () => fifo(join(repo, ".gitignore"))],
    ["a nested .gitignore", () => fifo(join(repo, "docs/.gitignore"))],
    [
      "core.excludesFile",
      () => {
        fifo(join(scratch, "excludes"));
        git(repo, "config", "core.excludesFile", join(scratch, "excludes"));
      },
    ],
    [
      "an include.path target",
      () => {
        fifo(join(repo, ".git/inc"));
        writeFileSync(
          join(repo, ".git/config"),
          readFileSync(join(repo, ".git/config"), "utf8") + "[include]\n\tpath = inc\n",
        );
      },
    ],
  ])("completes in under 3 s with a FIFO as %s", (_name, plant) => {
    plant();
    const { res, ms } = timedBootstrap();
    expect(ms).toBeLessThan(3000);
    expect(res.indexed).toEqual(expect.arrayContaining(["README.md", "docs/guide.md"]));
  });

  it("never spawns git to list files, and audits only from a neutral cwd", () => {
    const bin = join(scratch, "bin");
    const log = join(scratch, "git-calls.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$(pwd) :: $*" >> '${log}'\nexit 0\n`);
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}:${saved ?? ""}`;
    try {
      const { res } = timedBootstrap();
      expect(res.indexed).toContain("README.md");
    } finally {
      process.env["PATH"] = saved;
    }
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).not.toContain("ls-files");
    for (const line of calls.split("\n").filter(Boolean)) expect(line.startsWith(repo)).toBe(false);
  });
});
