import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  readonly path: string;
  cleanup(): void;
}

export interface TempRepoOptions {
  /** Run `git init` (local only, no remotes) inside the directory. */
  git?: boolean;
}

/** Create a throwaway directory populated with `files` (relative path -> contents). */
export function createTempRepo(
  files: Record<string, string | Buffer>,
  options: TempRepoOptions = {},
): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "sindri-repo-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  if (options.git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
  }
  return { path: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
