import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitConfigFindings, hardenedGitEnv, isDangerousGitKey, ownGitDir } from "./git-safety.js";

// Generous: these tests check config parsing, not machine speed (see bootstrap-git-safety).
const BUDGET = 30_000;

const fifo = (p: string) => execFileSync("mkfifo", [p]);

describe("isDangerousGitKey", () => {
  it.each([
    "diff.external",
    "diff.md.textconv",
    "diff.md.command",
    "difftool.vim.cmd",
    "mergetool.vim.cmd",
    "merge.ours.driver",
    "sequence.editor",
    "gpg.program",
    "gpg.ssh.defaultKeyCommand",
    "uploadpack.packObjectsHook",
    "remote.origin.uploadpack",
    "remote.origin.receivepack",
    "remote.origin.proxy",
    "remote.origin.vcs",
    "http.proxy",
    "http.https://example.com.proxy",
    "Core.FSMonitor",
    "core.worktree",
    "pager.log",
    "ssh.variant",
    "credential.https://example.com.helper",
  ])("flags %s", (key) => {
    expect(isDangerousGitKey(key)).toBe(true);
  });

  it.each([
    "diff.renames",
    "difftool.prompt",
    "merge.conflictStyle",
    "sequence.foo",
    "gpg.format",
    "uploadpack.allowFilter",
    "remote.origin.url",
    "http.sslVerify",
    "core.bare",
    "credential.username",
    "user.name",
    "",
  ])("does not flag %s", (key) => {
    expect(isDangerousGitKey(key)).toBe(false);
  });
});

// vi.stubEnv keeps the real process.env object (os.homedir() reads it, not a replacement).
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hardenedGitEnv", () => {
  it("keeps only allow-listed variables and forces the hardening ones", () => {
    vi.stubEnv("GIT_DIR", "/elsewhere");
    vi.stubEnv("LANG", "C");
    vi.stubEnv("LC_ALL", undefined);
    const env = hardenedGitEnv();
    expect(env["GIT_DIR"]).toBeUndefined();
    expect(env["LANG"]).toBe("C");
    expect("LC_ALL" in env).toBe(false);
    expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
  });
});

describe("gitConfigFindings", { timeout: 120_000 }, () => {
  let scratch: string;
  let root: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "sindri-gitcfg-"));
    root = join(scratch, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const config = (text: string, name = "config") => writeFileSync(join(root, ".git", name), text);

  it("has nothing to audit when .git is a gitdir pointer file", () => {
    rmSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    expect(ownGitDir(root)).toBeUndefined();
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([]);
  });

  it("reports a commondir redirect and non-regular config files without running git", () => {
    writeFileSync(join(root, ".git/commondir"), "../../elsewhere\n");
    fifo(join(root, ".git/config"));
    mkdirSync(join(root, ".git/config.worktree"));
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([
      "commondir",
      ".git/config:not-a-regular-file",
      ".git/config.worktree:not-a-regular-file",
    ]);
  });

  it("reads keys from config.worktree and keys without a value", () => {
    config("[core]\n\tbare = false\n");
    config("[core]\n\tfsmonitor\n", "config.worktree");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual(["core.fsmonitor"]);
  });

  it("reports each dangerous key once", () => {
    config("[alias]\n\tx = !true\n[alias]\n\tx = !false\n");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual(["alias.x"]);
  });

  it("reports a config git cannot parse as unparseable", () => {
    config("[core\n\tbroken = = =\n");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([".git/config:unparseable"]);
  });

  it("reports audit_timeout without running git when the budget is already spent", () => {
    config("[core]\n\tbare = false\n");
    config("[core]\n\tbare = false\n", "config.worktree");
    expect(gitConfigFindings(root, { budgetMs: 0 })).toEqual(["audit_timeout"]);
  });

  it("accepts a core.excludesFile that is a regular file", () => {
    writeFileSync(join(root, "excludes"), "*.log\n");
    config("[core]\n\texcludesFile = excludes\n");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([]);
  });

  // git resolves a relative core.excludesFile against the work tree it runs in, not .git/.
  it("flags a FIFO named by a relative core.excludesFile in the work tree", () => {
    fifo(join(root, "excludes"));
    config("[core]\n\texcludesFile = excludes\n");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([
      "core.excludesFile:not-a-regular-file",
    ]);
  });

  it("flags a FIFO named by a ~/ core.excludesFile under the home directory", () => {
    const home = join(scratch, "home");
    mkdirSync(home);
    fifo(join(home, "excludes"));
    vi.stubEnv("HOME", home);
    config("[core]\n\texcludesFile = ~/excludes\n");
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([
      "core.excludesFile:not-a-regular-file",
    ]);
  });

  it("flags a FIFO named by an absolute core.excludesFile", () => {
    fifo(join(scratch, "excludes"));
    config(`[core]\n\texcludesFile = ${join(scratch, "excludes")}\n`);
    expect(gitConfigFindings(root, { budgetMs: BUDGET })).toEqual([
      "core.excludesFile:not-a-regular-file",
    ]);
  });
});
