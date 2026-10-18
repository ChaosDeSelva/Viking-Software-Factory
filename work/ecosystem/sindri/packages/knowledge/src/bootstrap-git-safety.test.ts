import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditGitConfig, UnsafeGitConfigError } from "./bootstrap.js";
import { isSindriError } from "./errors.js";
import { openKnowledge, type Knowledge } from "./knowledge.js";

// Audit C1: the target repo's git config must never run code during bootstrap.

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
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Evil\n\nharmless looking readme\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
}

// Spawns several git processes per test; allow for slow, loaded machines.
// These tests check config parsing, not machine speed: they pass a generous audit budget so a
// loaded machine cannot turn a slow git spawn into a finding. The timeout path has its own
// deterministic test below.
const BUDGET = 30_000;

describe("bootstrapProject: untrusted git config", { timeout: 120_000 }, () => {
  let scratch: string;
  let sentinel: string;
  let k: Knowledge;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "sindri-gitsafety-"));
    sentinel = join(scratch, "PWNED");
    k = openKnowledge(":memory:");
  });
  afterEach(() => {
    k.close();
    process.env = { ...savedEnv };
    rmSync(scratch, { recursive: true, force: true });
  });

  const bootstrap = (repoPath: string) => {
    const id = k.projects.create({ name: "evil", repoPath }).id;
    return k.bootstrapProject(id, { repoPath, gitAuditBudgetMs: BUDGET });
  };

  it("never runs a planted core.fsmonitor command and still indexes via the walker", () => {
    const repo = join(scratch, "evil");
    initRepo(repo);
    git(repo, "config", "core.fsmonitor", `touch '${sentinel}'; false`);
    const res = bootstrap(repo);
    expect(existsSync(sentinel)).toBe(false);
    expect(res.indexed).toContain("README.md");
    expect(res.unsafeGitConfig).toContain("core.fsmonitor");
  });

  it("the walker fallback honours nested .gitignore files and .git/info/exclude", () => {
    const repo = join(scratch, "nested");
    initRepo(repo);
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/.gitignore"), "drafts.md\n");
    writeFileSync(join(repo, "docs/drafts.md"), "nested ignored draft\n");
    writeFileSync(join(repo, "docs/kept.md"), "kept doc\n");
    writeFileSync(join(repo, "docs/excluded.md"), "info excluded\n");
    writeFileSync(join(repo, ".git/info/exclude"), "docs/excluded.md\n");
    git(repo, "config", "alias.x", "!true");
    const res = bootstrap(repo);
    expect(res.unsafeGitConfig).toEqual(["alias.x"]);
    expect(res.indexed).toContain("docs/kept.md");
    expect(res.indexed).not.toContain("docs/drafts.md");
    expect(res.indexed).not.toContain("docs/excluded.md");
  });

  it("never runs a core.fsmonitor planted in a parent directory's .git", () => {
    const parent = join(scratch, "parent");
    initRepo(parent);
    git(parent, "config", "core.fsmonitor", `touch '${sentinel}'; false`);
    const sub = join(parent, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "README.md"), "# Sub\n");
    const res = bootstrap(sub);
    expect(existsSync(sentinel)).toBe(false);
    expect(res.indexed).toContain("README.md");
  });

  it("ignores fsmonitor injected through the caller's GIT_CONFIG_* environment", () => {
    const repo = join(scratch, "clean");
    initRepo(repo);
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = "core.fsmonitor";
    process.env["GIT_CONFIG_VALUE_0"] = `touch '${sentinel}'; false`;
    process.env["GIT_CONFIG_PARAMETERS"] = `'core.fsmonitor'='touch ${sentinel}; false'`;
    const res = bootstrap(repo);
    expect(existsSync(sentinel)).toBe(false);
    expect(res.indexed).toContain("README.md");
    expect(res.unsafeGitConfig).toBeUndefined();
  });

  it("refuses git when config pulls in another file through include.path", () => {
    const repo = join(scratch, "inc");
    initRepo(repo);
    const extra = join(scratch, "extra.gitconfig");
    writeFileSync(extra, `[core]\n\tfsmonitor = touch '${sentinel}'; false\n`);
    git(repo, "config", "include.path", extra);
    const res = bootstrap(repo);
    expect(existsSync(sentinel)).toBe(false);
    expect(res.unsafeGitConfig).toContain("include.path");
  });

  it.each([
    ["core.fsmonitor", "touch x"],
    ["core.hooksPath", "/nonexistent/hooks"],
    ["filter.evil.clean", "touch x"],
    ["alias.ls", "!touch x"],
    ["include.path", "/nonexistent/sindri-x"],
    ["includeIf.gitdir:/.path", "/nonexistent/sindri-x"],
    ["credential.helper", "!touch x"],
    ["core.sshCommand", "touch x"],
    ["core.gitProxy", "touch x"],
  ])("auditGitConfig fails closed with a typed error on %s", (key, value) => {
    const repo = join(scratch, "audit");
    initRepo(repo);
    git(repo, "config", key, value);
    let err: unknown;
    try {
      auditGitConfig(repo, { budgetMs: BUDGET });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsafeGitConfigError);
    expect(isSindriError(err)).toBe(true);
    expect((err as UnsafeGitConfigError).keys.map((x) => x.toLowerCase())).toContain(
      key.toLowerCase(),
    );
  });

  it("auditGitConfig passes a plain repo", () => {
    const repo = join(scratch, "plain");
    initRepo(repo);
    expect(() => auditGitConfig(repo, { budgetMs: BUDGET })).not.toThrow();
  });

  it("reports a budget overrun as audit_timeout (never unparseable) and still walks", () => {
    const repo = join(scratch, "slow");
    initRepo(repo);
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    // A git that never answers in time; exec so the kill reaches the sleeping process.
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 10\n");
    chmodSync(join(bin, "git"), 0o755);
    process.env["PATH"] = `${bin}:${savedEnv["PATH"] ?? ""}`;
    const id = k.projects.create({ name: "slow", repoPath: repo }).id;
    const t0 = performance.now();
    const res = k.bootstrapProject(id, { repoPath: repo, gitAuditBudgetMs: 300 });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(res.unsafeGitConfig).toEqual(["audit_timeout"]);
    expect(res.indexed).toContain("README.md");
    let err: unknown;
    try {
      auditGitConfig(repo, { budgetMs: 300 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsafeGitConfigError);
    expect((err as UnsafeGitConfigError).keys).toEqual(["audit_timeout"]);
  });
});
