import { spawn } from "node:child_process";
import { MimirError } from "@mimir/protocol";

/**
 * Config overrides applied to every git invocation. They neutralise the command-running knobs
 * that git consults during the operations Mimir performs (hooks, fsmonitor, signature
 * verification, ssh/credential helpers). Repo-local filter/merge/diff drivers are handled by the
 * config audit and by running analysis in a Mimir-owned scratch repository.
 */
export const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "log.showSignature=false",
  "-c",
  "gpg.program=/usr/bin/false",
  "-c",
  "core.sshCommand=/usr/bin/false",
  "-c",
  "credential.helper=",
];

const MAX_OUTPUT = 64 * 1024 * 1024;

/** Variables copied from the parent environment for git. Nothing else is inherited. */
export const GIT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"] as const;

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOptions {
  /** Explicit extra environment variables (e.g. GIT_INDEX_FILE, GIT_DIR). */
  env?: Record<string, string>;
  /** Exit codes besides 0 that are not treated as errors. */
  okExitCodes?: number[];
  /** Data written to git's stdin. */
  input?: string | Buffer;
}

/** Environment for git: an allowlist from the parent plus fixed hardening values and extras. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

/** Runs `git` with an argument array (never a shell) in `cwd`. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...args], {
      cwd,
      env: gitEnv(options.env),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) =>
      reject(
        new MimirError("internal", `git failed to start: ${e.message}`, { args }, { cause: e }),
      ),
    );
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      const exitCode = code ?? -1;
      if (!overflow && (exitCode === 0 || options.okExitCodes?.includes(exitCode))) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(
        new MimirError(
          "internal",
          overflow
            ? `git ${args[0] ?? ""} output exceeded ${MAX_OUTPUT} bytes`
            : `git ${args[0] ?? ""} failed: ${stderr.trim()}`,
          { args, exitCode, stderr: stderr.trim() },
        ),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Rejects refs that git could parse as options. */
export function assertRefArg(ref: string, field: string): void {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || ref.includes("\0")) {
    throw new MimirError("validation_failed", `${field} is not a valid ref`, { field, ref });
  }
}

/** Resolves `ref` to a commit sha in `cwd`, or throws `not_found`. */
export async function resolveCommit(
  cwd: string,
  ref: string,
  field: string,
  options: GitOptions = {},
): Promise<string> {
  assertRefArg(ref, field);
  const r = await git(
    cwd,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { ...options, okExitCodes: [1, 128] },
  );
  const sha = r.stdout.trim();
  if (r.exitCode !== 0 || !sha) {
    throw new MimirError("not_found", `${field} '${ref}' does not resolve to a commit`, {
      field,
      ref,
    });
  }
  return sha;
}

const AUDIT_PATTERNS: RegExp[] = [
  /^filter\./,
  /^merge\..+\.driver$/,
  /^diff\..+\.(command|textconv)$/,
  /^diff\.external$/,
  /^core\.(sshcommand|gitproxy|fsmonitor|hookspath|askpass|editor|pager|alternaterefscommand)$/,
  /^credential\./,
  /^gpg\.(.+\.)?program$/,
  /^alias\./,
  /^include\.path$/,
  /^includeif\./,
  /^sequence\.editor$/,
  /^uploadpack\.packobjectshook$/,
  /^extensions\.worktreeconfig$/,
];

/**
 * Fails closed with `policy_denied` when the repository's own (agent-writable) config — local or
 * per-worktree scope — defines anything that makes git run a command. Global config belongs to
 * the operator and is not audited.
 */
export async function auditRepoConfig(cwd: string): Promise<void> {
  const r = await git(cwd, ["config", "--list", "--no-includes", "--show-scope", "-z"], {
    okExitCodes: [1],
  });
  // With --show-scope -z, records are "<scope>\0<key>\n<value>\0".
  const parts = r.stdout.split("\0");
  const keys = new Set<string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== "local" && scope !== "worktree") continue;
    const kv = parts[i + 1] ?? "";
    const nl = kv.indexOf("\n");
    const key = (nl < 0 ? kv : kv.slice(0, nl)).toLowerCase();
    if (AUDIT_PATTERNS.some((p) => p.test(key))) keys.add(key);
  }
  if (keys.size > 0) {
    throw new MimirError(
      "policy_denied",
      "repository config defines commands git could run; refusing to operate",
      { cwd, keys: [...keys].sort() },
    );
  }
}
