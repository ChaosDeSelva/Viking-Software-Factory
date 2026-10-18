import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git (argument array, no shell) in `cwd` with a clean identity; returns trimmed stdout. */
export function sh(cwd: string, ...args: string[]): string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  }
  return execFileSync("git", args, {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export class TempDirs {
  private dirs: string[] = [];
  async make(prefix: string): Promise<string> {
    const d = await realpath(await mkdtemp(join(tmpdir(), `mimir-git-${prefix}-`)));
    this.dirs.push(d);
    return d;
  }
  async cleanup(): Promise<void> {
    await Promise.all(this.dirs.map((d) => rm(d, { recursive: true, force: true })));
    this.dirs = [];
  }
}

let template: string | undefined;

/** Builds the base repo once per test file; each test gets a byte-for-byte copy. */
function templateRepo(): string {
  if (template) return template;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-git-template-")));
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.txt"), "bee\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "initial");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  template = dir;
  return dir;
}

/** Creates a disposable repo on branch `main` with files a.txt (3 lines) and b.txt. */
export async function makeRepo(dirs: TempDirs): Promise<string> {
  const repo = await dirs.make("repo");
  await cp(templateRepo(), repo, { recursive: true });
  return repo;
}

export async function commitFile(cwd: string, file: string, content: string, msg: string) {
  await writeFile(join(cwd, file), content);
  sh(cwd, "add", "--", file);
  sh(cwd, "commit", "-q", "-m", msg);
  return sh(cwd, "rev-parse", "HEAD");
}
