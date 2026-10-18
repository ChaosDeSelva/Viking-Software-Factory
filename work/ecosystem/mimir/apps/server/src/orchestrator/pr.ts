import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface PrRequest {
  repoPath: string;
  worktreePath: string;
  branch: string;
  title: string;
  body: string;
}

/** Opens a pull request for a task branch. Never pushes and never merges. */
export interface PrRunner {
  /** True when `gh` is installed and the repository has at least one remote. */
  available(repoPath: string): Promise<boolean>;
  create(request: PrRequest): Promise<{ output: string }>;
}

/** Local delivery is the default even when a project has a remote or gh is installed. */
export class LocalDeliveryRunner implements PrRunner {
  async available(): Promise<boolean> {
    return false;
  }

  async create(): Promise<{ output: string }> {
    throw new Error("Remote delivery is disabled; use the local delivery artifact");
  }
}

export type ExecFn = (
  file: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, opts) =>
  promisify(execFile)(file, [...args], opts) as Promise<{ stdout: string; stderr: string }>;

/** Environment variables passed through to `gh`/`git` (everything else is dropped). */
export const PR_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
];

/** Git config forced on every call: no hooks, no fsmonitor, no external helpers or transports. */
const HARDENING: readonly [string, string][] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.sshCommand", "ssh"],
  ["credential.helper", ""],
  ["protocol.ext.allow", "never"],
  ["protocol.file.allow", "never"],
  ["diff.external", ""],
];

/**
 * Minimal, pinned environment: the trusted repository's own `.git` (never one reachable from
 * the agent's worktree), no system/global git config, hardening keys via GIT_CONFIG_COUNT.
 */
export function prEnv(repoPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PR_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env["GIT_DIR"] = join(repoPath, ".git");
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_COUNT"] = String(HARDENING.length);
  HARDENING.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function hasGitDir(repoPath: string): boolean {
  try {
    return statSync(join(repoPath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `gh pr create --head <branch>` as an argv array, run from the trusted project `repoPath` (not
 * the agent-writable worktree). `gh` refuses when the branch is not on the remote; Mimir does not
 * push it.
 */
export class GhPrRunner implements PrRunner {
  private readonly exec: ExecFn;

  constructor(options: { exec?: ExecFn } = {}) {
    this.exec = options.exec ?? defaultExec;
  }

  async available(repoPath: string): Promise<boolean> {
    if (!hasGitDir(repoPath)) return false;
    const opts = { cwd: repoPath, env: prEnv(repoPath), timeout: 10_000 };
    try {
      await this.exec("gh", ["--version"], opts);
      const { stdout } = await this.exec("git", ["remote"], opts);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async create(request: PrRequest): Promise<{ output: string }> {
    const { stdout, stderr } = await this.exec(
      "gh",
      ["pr", "create", "--head", request.branch, "--title", request.title, "--body", request.body],
      { cwd: request.repoPath, env: prEnv(request.repoPath), timeout: 120_000 },
    );
    return { output: `${stdout}${stderr}` };
  }
}
