import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_WORKSPACE_BYTES,
  applyResult,
  digest,
  git,
  restore,
  safePath,
  snapshot,
} from "./workspace.js";

// Every case spawns git several times; the default 5 s is not enough on a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository(files: Record<string, string> = { "hello.txt": "original\n" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-workspace-")));
  roots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, ["init", "--quiet"]);
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), data);
  }
  commit(cwd);
  return { root, cwd };
}
function commit(cwd: string) {
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "change",
  ]);
}
/** A patch as the remote worker produces it: staged changes against the submitted input. */
function patchOf(cwd: string, change: () => void) {
  change();
  git(cwd, ["add", "-A"]);
  const patch = git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
  git(cwd, ["reset", "--quiet", "--hard", "HEAD"]);
  git(cwd, ["clean", "-fdq"]);
  return patch;
}

it("accepts only relative paths that stay inside the worktree and outside .git", () => {
  for (const path of ["a", "src/a.ts", "a b/c", ".gitignore", "dir/.github/x"])
    expect(safePath(path)).toBe(true);
  for (const path of [
    "",
    "/etc/passwd",
    "../escape",
    "a/../b",
    "a//b",
    "./a",
    "a/",
    ".git/config",
    "sub/.GIT/hooks/pre-commit",
    "a\\b",
    "a\nb",
    "a\u007fb",
  ])
    expect(safePath(path)).toBe(false);
});

it("snapshots tracked files with their mode and ignores untracked ones", () => {
  const { cwd } = repository({ "hello.txt": "original\n", "bin/run": "#!/bin/sh\n" });
  chmodSync(join(cwd, "bin/run"), 0o755);
  writeFileSync(join(cwd, "untracked.txt"), "local only");
  const files = snapshot(cwd);
  expect(files).toEqual([
    { path: "bin/run", data: Buffer.from("#!/bin/sh\n").toString("base64"), executable: true },
    { path: "hello.txt", data: Buffer.from("original\n").toString("base64"), executable: false },
  ]);
  // The digest follows content: it is what detects a local edit made during remote execution.
  writeFileSync(join(cwd, "hello.txt"), "edited\n");
  expect(digest(snapshot(cwd))).not.toBe(digest(files));
});

it("refuses to ship symlinks, unsafe names and oversized workspaces", () => {
  const linked = repository();
  symlinkSync("/etc/hosts", join(linked.cwd, "link"));
  commit(linked.cwd);
  expect(() => snapshot(linked.cwd)).toThrow(/regular tracked files/);

  const unsafe = repository({ "a\\b.txt": "x" });
  expect(() => snapshot(unsafe.cwd)).toThrow("Workspace contains an unsafe path");

  const large = repository({ "big.bin": "x" });
  writeFileSync(join(large.cwd, "big.bin"), Buffer.alloc(MAX_WORKSPACE_BYTES + 1));
  expect(() => snapshot(large.cwd)).toThrow(/exceeds 8 MiB/);
});

it("restores a snapshot byte for byte and refuses anything that could escape or overwrite", () => {
  const { root, cwd } = repository({ "hello.txt": "original\n", "bin/run": "#!/bin/sh\n" });
  chmodSync(join(cwd, "bin/run"), 0o755);
  const files = snapshot(cwd);
  const target = join(root, "restored");
  restore(target, files);
  expect(readFileSync(join(target, "hello.txt"), "utf8")).toBe("original\n");
  expect(statSync(join(target, "bin/run")).mode & 0o111).not.toBe(0);
  expect(statSync(join(target, "hello.txt")).mode & 0o111).toBe(0);

  const file = (path: string, data = "") => ({ path, data, executable: false });
  const fresh = (name: string) => join(root, name);
  expect(() => restore(fresh("escape"), [file("../escape")])).toThrow(/Unsafe or duplicate/);
  expect(existsSync(join(root, "escape"))).toBe(false);
  expect(() => restore(fresh("hook"), [file(".git/hooks/pre-commit")])).toThrow(
    /Unsafe or duplicate/,
  );
  expect(() => restore(fresh("twice"), [file("a"), file("a")])).toThrow(/Unsafe or duplicate/);
  expect(() => restore(fresh("encoding"), [file("a", "not base64!")])).toThrow(
    "Invalid source encoding",
  );
  const half = Buffer.alloc(MAX_WORKSPACE_BYTES / 2 + 1).toString("base64");
  expect(() => restore(fresh("big"), [file("a", half), file("b", half)])).toThrow(
    "Workspace limit exceeded",
  );
  // Never overwrites: a second restore into the same directory fails instead of replacing files.
  expect(() => restore(target, files)).toThrow(/EEXIST/);
});

it("applies a returned patch only onto the unchanged input", () => {
  const { cwd } = repository();
  const baseline = digest(snapshot(cwd));
  const patch = patchOf(cwd, () => {
    writeFileSync(join(cwd, "hello.txt"), "remote\n");
    writeFileSync(join(cwd, "new.txt"), "created\n");
  });
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("original\n");
  applyResult(cwd, baseline, "");
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("original\n");
  applyResult(cwd, baseline, patch);
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("remote\n");
  expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("created\n");
  // The worktree no longer matches the submitted input, so the same patch cannot land twice.
  expect(() => applyResult(cwd, baseline, patch)).toThrow(/manual reconciliation/);
});

it("rejects oversized patches and patches that do not apply, leaving the worktree alone", () => {
  const { cwd } = repository();
  const baseline = digest(snapshot(cwd));
  expect(() => applyResult(cwd, baseline, "x".repeat(MAX_WORKSPACE_BYTES + 1))).toThrow(
    "Returned patch exceeds 8 MiB",
  );
  const stale = [
    "diff --git a/hello.txt b/hello.txt",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-something else",
    "+remote",
    "",
  ].join("\n");
  expect(() => applyResult(cwd, baseline, stale)).toThrow();
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("original\n");
});

it("never lets a returned patch write into .git or outside the worktree", () => {
  const { root, cwd } = repository();
  const baseline = digest(snapshot(cwd));
  const create = (path: string, mode = "100755", body = "+#!/bin/sh") =>
    [
      `diff --git a/${path} b/${path}`,
      `new file mode ${mode}`,
      "index 0000000..9daeafb",
      "--- /dev/null",
      `+++ b/${path}`,
      "@@ -0,0 +1 @@",
      body,
      "",
    ].join("\n");
  for (const path of [".git/hooks/pre-commit", ".GIT/hooks/pre-commit", "../outside.txt"]) {
    expect(() => applyResult(cwd, baseline, create(path))).toThrow();
  }
  expect(existsSync(join(cwd, ".git/hooks/pre-commit"))).toBe(false);
  expect(existsSync(join(root, "outside.txt"))).toBe(false);
  // A symlink created by the patch cannot be used by the same patch to leave the worktree.
  mkdirSync(join(root, "outside"));
  const throughLink =
    create("link", "120000", "+../outside\n\\ No newline at end of file") +
    create("link/evil.txt", "100644", "+evil");
  expect(() => applyResult(cwd, baseline, throughLink)).toThrow();
  expect(existsSync(join(root, "outside", "evil.txt"))).toBe(false);
  expect(existsSync(join(cwd, "link"))).toBe(false);
});
