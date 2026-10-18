import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { REPO_ROOT, homeFor, tmp } from "./helpers.js";

export const E2E_FIXTURES = resolve(REPO_ROOT, "tests/fixtures");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/**
 * Copy the React fixture into a fresh git repository, install the given
 * fixture harnesses as project-local harnesses and configure them.
 */
export function e2eRepo(harnesses: string[], options: { commit?: boolean } = {}): string {
  const dir = join(realpathSync(tmp("brokkr-e2e-")), "app");
  cpSync(join(E2E_FIXTURES, "react-app"), dir, { recursive: true });
  for (const h of harnesses) {
    cpSync(join(E2E_FIXTURES, "harnesses", h), join(dir, ".brokkr", "harnesses", h), {
      recursive: true,
    });
  }
  mkdirSync(join(dir, ".brokkr"), { recursive: true });
  writeFileSync(
    join(dir, ".brokkr", "config.yaml"),
    stringify({ version: 1, harnesses: harnesses.map((name) => ({ name, version: "^1.0.0" })) }),
  );
  writeFileSync(join(dir, ".gitignore"), "pids\n");
  homeFor(dir);
  git(dir, "init", "-q");
  if (options.commit !== false) {
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "fixture");
  }
  return dir;
}

/**
 * A PATH containing only node, pnpm, tsc (the workspace TypeScript) and the
 * system directories, so results do not depend on globally installed tools.
 */
export function toolPath(options: { tsc?: boolean } = {}): string {
  const bin = join(realpathSync(tmp("brokkr-bin-")), "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  symlinkSync(pnpm, join(bin, "pnpm"));
  if (options.tsc !== false) {
    const tscJs = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    writeFileSync(join(bin, "tsc"), `#!/bin/sh\nexec "${process.execPath}" "${tscJs}" "$@"\n`);
    chmodSync(join(bin, "tsc"), 0o755);
  }
  return `${bin}:/usr/bin:/bin`;
}
