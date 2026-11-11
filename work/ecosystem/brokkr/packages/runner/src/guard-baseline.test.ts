import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { whenHeldAtBase } from "./index.js";
import { tmp } from "../test/helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** A repository whose base commit has a test script, a migrations directory and a nested package. */
function repo(): { dir: string; base: string } {
  const dir = tmp("brokkr-base-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x", lint: "y" } }));
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "001.sql"), "select 1;\n");
  mkdirSync(join(dir, "packages", "api"), { recursive: true });
  writeFileSync(
    join(dir, "packages", "api", "package.json"),
    JSON.stringify({ scripts: { build: "z" } }),
  );
  return { dir, base: commit(dir, "base") };
}

describe("whenHeldAtBase: a `when` guard evaluated against the base commit", () => {
  it("reads files, directories and package scripts from the base tree, not the working tree", async () => {
    const { dir, base } = repo();
    // The work under test removes everything the guards read, and commits that.
    rmSync(join(dir, "migrations"), { recursive: true });
    rmSync(join(dir, "tsconfig.json"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    commit(dir, "agent work");
    const at = { workspace: dir, cwd: ".", baseCommit: base };

    expect(await whenHeldAtBase({ fileExists: ["tsconfig.json", "migrations"] }, at)).toEqual({
      status: "held",
    });
    expect(await whenHeldAtBase({ scriptExists: ["test", "lint"] }, at)).toEqual({
      status: "held",
    });
    expect(
      await whenHeldAtBase({ anyFileExists: ["playwright.config.ts", "tsconfig.json"] }, at),
    ).toEqual({ status: "held" });
    expect(
      await whenHeldAtBase({ fileExists: ["migrations"], scriptExists: ["test"] }, at),
    ).toEqual({ status: "held" });
  });

  it("reports which condition did not hold at the base", async () => {
    const { dir, base } = repo();
    const at = { workspace: dir, cwd: ".", baseCommit: base };
    const short = base.slice(0, 12);

    expect(await whenHeldAtBase({ fileExists: ["tsconfig.json", "Dockerfile"] }, at)).toEqual({
      status: "not_held",
      detail: `'Dockerfile' did not exist at base ${short}`,
    });
    expect(
      await whenHeldAtBase({ anyFileExists: ["playwright.config.ts", "playwright.config.js"] }, at),
    ).toEqual({
      status: "not_held",
      detail: `none of playwright.config.ts, playwright.config.js existed at base ${short}`,
    });
    expect(await whenHeldAtBase({ scriptExists: ["test", "e2e"] }, at)).toEqual({
      status: "not_held",
      detail: `package.json had no 'e2e' script at base ${short}`,
    });
    // AND across keys: the file condition holds, the script condition does not.
    expect(
      await whenHeldAtBase({ fileExists: ["migrations"], scriptExists: ["db:migrate"] }, at),
    ).toMatchObject({ status: "not_held" });
  });

  it("resolves guard paths against the check cwd, and never outside the repository tree", async () => {
    const { dir, base } = repo();
    const at = { workspace: dir, cwd: "packages/api", baseCommit: base };

    expect(await whenHeldAtBase({ scriptExists: ["build"] }, at)).toEqual({ status: "held" });
    expect(await whenHeldAtBase({ scriptExists: ["test"] }, at)).toMatchObject({
      status: "not_held",
    });
    expect(await whenHeldAtBase({ fileExists: ["../../tsconfig.json"] }, at)).toEqual({
      status: "held",
    });
    expect(await whenHeldAtBase({ fileExists: ["."] }, { ...at, cwd: "." })).toEqual({
      status: "held",
    });
    // A file outside the repository is not in the base tree, so the base cannot say.
    expect(await whenHeldAtBase({ fileExists: ["../../../etc/passwd"] }, at)).toEqual({
      status: "unknown",
      detail: "'../../../etc/passwd' is outside the repository",
    });
    // A path through a file does not exist.
    expect(await whenHeldAtBase({ fileExists: ["package.json/x"] }, at)).toMatchObject({
      status: "not_held",
    });
    expect(await whenHeldAtBase({ fileExists: ["../../migrations/"] }, at)).toEqual({
      status: "held",
    });
    expect(await whenHeldAtBase({ scriptExists: ["x"] }, { ...at, cwd: ".." })).toEqual({
      status: "unknown",
      detail: "check cwd '..' is outside the repository",
    });
  });

  it("answers only when the workspace is the repository's top level", async () => {
    const { dir, base } = repo();
    // git's idea of the top level is repository config, which the work under test controls.
    expect(
      await whenHeldAtBase(
        { scriptExists: ["build"] },
        { workspace: join(dir, "packages", "api"), cwd: ".", baseCommit: base },
      ),
    ).toEqual({
      status: "unknown",
      detail: "the workspace is not the top level of its git repository",
    });
    // Pointing core.worktree at the parent would otherwise make every guard path miss.
    git(dir, "config", "core.worktree", join(dir, ".."));
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: base },
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it("a base package.json without usable scripts has no scripts", async () => {
    for (const text of ["{ not json", JSON.stringify({ scripts: "test" }), "null"]) {
      const dir = tmp("brokkr-base-");
      git(dir, "init", "-q");
      writeFileSync(join(dir, "package.json"), text);
      const base = commit(dir, "base");
      expect(
        await whenHeldAtBase(
          { scriptExists: ["test"] },
          { workspace: dir, cwd: ".", baseCommit: base },
        ),
        text,
      ).toMatchObject({ status: "not_held" });
    }
    const dir = tmp("brokkr-base-");
    git(dir, "init", "-q");
    const base = commit(dir, "empty");
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: base },
      ),
    ).toMatchObject({ status: "not_held" });
    expect(
      await whenHeldAtBase({ scriptExists: [] }, { workspace: dir, cwd: ".", baseCommit: base }),
    ).toEqual({ status: "held" });
  });

  it("a replace ref planted by the work under test cannot substitute another tree for the base", async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    const stripped = commit(dir, "agent work");
    git(dir, "replace", base, stripped);
    // Plain git now shows the stripped tree for the base commit...
    expect(git(dir, "show", `${base}:package.json`)).toBe('{"scripts":{}}');
    // ...but the guard still sees the real one.
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: base },
      ),
    ).toEqual({ status: "held" });
  });

  it("cannot answer without a real base commit in a git repository", async () => {
    const { dir, base } = repo();
    const absent = "0123456789abcdef0123456789abcdef01234567";
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: absent },
      ),
    ).toEqual({
      status: "unknown",
      detail: `commit ${absent} is missing from the workspace repository or does not match its id`,
    });
    // A branch name could be moved by the work under test: only full commit ids are accepted.
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: "HEAD" },
      ),
    ).toEqual({ status: "unknown", detail: "'HEAD' is not a full commit id" });
    // A tree id is content-addressed too, but it is not a commit.
    const tree = git(dir, "rev-parse", `${base}^{tree}`);
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: dir, cwd: ".", baseCommit: tree },
      ),
    ).toMatchObject({ status: "unknown" });

    const plain = tmp("brokkr-nogit-");
    writeFileSync(join(plain, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    expect(
      await whenHeldAtBase(
        { scriptExists: ["test"] },
        { workspace: plain, cwd: ".", baseCommit: base },
      ),
    ).toEqual({ status: "unknown", detail: "the workspace is not a git repository" });
  });

  it("objects the work under test rewrote or deleted make the answer unknown, never a forged one", async () => {
    const { dir, base } = repo();
    const at = { workspace: dir, cwd: ".", baseCommit: base };
    const blob = git(dir, "rev-parse", `${base}:package.json`);
    const loose = join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    // Swap the loose object for one holding a package.json without scripts: git serves it as-is.
    const fake = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: '{"scripts":{}}',
      encoding: "utf8",
    }).trim();
    chmodSync(loose, 0o644);
    copyFileSync(join(dir, ".git", "objects", fake.slice(0, 2), fake.slice(2)), loose);
    expect(git(dir, "cat-file", "-p", `${base}:package.json`)).toBe('{"scripts":{}}');
    expect(await whenHeldAtBase({ scriptExists: ["test"] }, at)).toEqual({
      status: "unknown",
      detail: `blob ${blob} is missing from the workspace repository or does not match its id`,
    });

    // Deleting a tree object hides the migrations directory from plain git.
    const migrations = git(dir, "rev-parse", `${base}:migrations`);
    unlinkSync(join(dir, ".git", "objects", migrations.slice(0, 2), migrations.slice(2)));
    expect(await whenHeldAtBase({ fileExists: ["migrations/001.sql"] }, at)).toEqual({
      status: "unknown",
      detail: `tree ${migrations} is missing from the workspace repository or does not match its id`,
    });
    // The directory entry itself is still read from the (intact) root tree.
    expect(await whenHeldAtBase({ fileExists: ["migrations"] }, at)).toEqual({ status: "held" });
  });

  it("symlinks, submodules and letter-case variants at the base cannot be answered", async () => {
    const dir = tmp("brokkr-base-");
    git(dir, "init", "-q");
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    symlinkSync("real", join(dir, "link"));
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    const base = commit(dir, "base");
    const at = { workspace: dir, cwd: ".", baseCommit: base };
    const short = base.slice(0, 12);
    expect(await whenHeldAtBase({ fileExists: ["link"] }, at)).toEqual({
      status: "unknown",
      detail: `'link' is a symlink or submodule at base ${short}`,
    });
    expect(await whenHeldAtBase({ scriptExists: ["test"] }, { ...at, cwd: "link" })).toEqual({
      status: "unknown",
      detail: `'package.json' is under a symlink or submodule at base ${short}`,
    });
    expect(await whenHeldAtBase({ fileExists: ["dockerfile"] }, at)).toEqual({
      status: "unknown",
      detail: `'dockerfile' exists at base ${short} only in another letter case`,
    });
    expect(await whenHeldAtBase({ scriptExists: ["test"] }, { ...at, cwd: "real" })).toEqual({
      status: "held",
    });
  });

  it("an object that is not a commit, or a commit object without a tree line, is unknown", async () => {
    const { dir } = repo();
    // A blob whose id is well-formed: cat-file refuses it as a commit.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: "not a commit",
      encoding: "utf8",
    }).trim();
    expect(
      await whenHeldAtBase({ fileExists: ["x"] }, { workspace: dir, cwd: ".", baseCommit: blob }),
    ).toMatchObject({ status: "unknown" });
    // A genuine commit object (its id matches) that names no tree.
    const treeless = execFileSync(
      "git",
      ["hash-object", "-t", "commit", "--literally", "-w", "--stdin"],
      { cwd: dir, input: "author t <t@example.invalid> 0 +0000\n\nno tree\n", encoding: "utf8" },
    ).trim();
    expect(
      await whenHeldAtBase(
        { fileExists: ["x"] },
        { workspace: dir, cwd: ".", baseCommit: treeless },
      ),
    ).toEqual({ status: "unknown", detail: `commit ${treeless} has no tree` });
  });

  it("reads a SHA-256 repository, verifying objects with SHA-256", async () => {
    const dir = tmp("brokkr-base-");
    git(dir, "init", "-q", "--object-format=sha256");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    const base = commit(dir, "base");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const at = { workspace: dir, cwd: ".", baseCommit: base };
    expect(await whenHeldAtBase({ scriptExists: ["test"] }, at)).toEqual({ status: "held" });
    expect(await whenHeldAtBase({ fileExists: ["tsconfig.json"] }, at)).toMatchObject({
      status: "not_held",
    });
  });
});
