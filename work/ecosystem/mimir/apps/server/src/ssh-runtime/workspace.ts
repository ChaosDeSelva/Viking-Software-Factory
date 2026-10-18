import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;
export type SourceFile = { path: string; data: string; executable: boolean };
export const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", ...args],
    {
      cwd,
      env: gitEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      ...(input === undefined ? {} : { input }),
    },
  );
}
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === "\\") &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git")
  );
}
export function snapshot(cwd: string): SourceFile[] {
  const names = git(cwd, ["ls-files", "-z"]).split("\0").filter(Boolean);
  let bytes = 0;
  return names.map((path) => {
    if (!safePath(path)) throw new Error("Workspace contains an unsafe path");
    const stat = lstatSync(join(cwd, path));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(
        "SSH workspaces currently require regular tracked files (no symlinks or submodules)",
      );
    bytes += stat.size;
    if (bytes > MAX_WORKSPACE_BYTES)
      throw new Error("SSH workspace exceeds 8 MiB tracked-source limit");
    return {
      path,
      data: readFileSync(join(cwd, path)).toString("base64"),
      executable: Boolean(stat.mode & 0o111),
    };
  });
}
export function digest(files: SourceFile[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
export function restore(cwd: string, files: SourceFile[]) {
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!safePath(file.path) || seen.has(file.path))
      throw new Error("Unsafe or duplicate workspace path");
    seen.add(file.path);
    const data = Buffer.from(file.data, "base64");
    if (data.toString("base64") !== file.data) throw new Error("Invalid source encoding");
    bytes += data.length;
    if (bytes > MAX_WORKSPACE_BYTES) throw new Error("Workspace limit exceeded");
    mkdirSync(dirname(join(cwd, file.path)), { recursive: true });
    writeFileSync(join(cwd, file.path), data, {
      flag: "wx",
      mode: file.executable ? 0o755 : 0o644,
    });
  }
}
export function applyResult(cwd: string, baseline: string, patch: string) {
  if (digest(snapshot(cwd)) !== baseline)
    throw new Error(
      "Local worktree changed during remote execution; manual reconciliation required",
    );
  if (Buffer.byteLength(patch) > MAX_WORKSPACE_BYTES)
    throw new Error("Returned patch exceeds 8 MiB");
  if (!patch) return;
  git(cwd, ["apply", "--check", "--binary", "-"], patch);
  git(cwd, ["apply", "--binary", "-"], patch);
}
