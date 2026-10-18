import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { SindriError } from "./errors.js";

/**
 * Bootstrap never runs git to list files (it always uses the filesystem walker), because an
 * untrusted repository can make git run commands (`core.fsmonitor`, `filter.*`, `alias.*`,
 * hooks, credential helpers, ...) or block on FIFOs planted where git reads (`.git/index`,
 * `.gitignore`, `core.excludesFile`, ...).
 *
 * The only git invocation left is this audit, which reports a repository whose own config would
 * be dangerous for git commands. It is a reporting denylist scoped to what Sindri used to run
 * (`ls-files`), not a general guarantee that running other git commands in the repo is safe.
 * It touches git only after checking that every file git could read is a regular file, runs
 * `git config --file <f> --no-includes` from a neutral cwd with a scrubbed environment, and
 * has a total time budget of {@link AUDIT_BUDGET_MS}.
 */

/** Default total time the audit may block the caller (it is synchronous). */
export const AUDIT_BUDGET_MS = 2000;

/** Finding reported when git did not answer within the audit budget (fail closed). */
export const AUDIT_TIMEOUT = "audit_timeout";

export interface GitAuditOptions {
  /** Total time budget for the audit's git calls. Default {@link AUDIT_BUDGET_MS}. */
  budgetMs?: number;
}

/** The repo-local git config contains keys (or files) that make running git unsafe. */
export class UnsafeGitConfigError extends SindriError {
  override name = "UnsafeGitConfigError";
  constructor(readonly keys: string[]) {
    super("validation_failed", `repository git config is unsafe: ${keys.join(", ")}`, { keys });
  }
}

/** True for config keys (as printed by `git config --list`) that can execute code. */
export function isDangerousGitKey(name: string): boolean {
  const lower = name.toLowerCase();
  const parts = lower.split(".");
  const section = parts[0] ?? "";
  const key = parts[parts.length - 1] ?? "";
  if (["alias", "filter", "include", "includeif", "pager", "ssh"].includes(section)) return true;
  if (section === "credential" && key === "helper") return true;
  if (section === "core") {
    return [
      "fsmonitor",
      "hookspath",
      "sshcommand",
      "gitproxy",
      "pager",
      "editor",
      "askpass",
      "alternaterefscommand",
      "worktree",
    ].includes(key);
  }
  if (section === "diff") return key === "external" || key === "textconv" || key === "command";
  if (section === "difftool" || section === "mergetool") return key === "cmd";
  if (section === "merge") return key === "driver";
  if (section === "sequence") return key === "editor";
  if (section === "gpg") return key === "program" || key === "defaultkeycommand";
  if (section === "uploadpack") return key === "packobjectshook";
  if (section === "remote")
    return key === "uploadpack" || key === "receivepack" || key === "proxy" || key === "vcs";
  if (section === "http") return key === "proxy";
  return false;
}

/** Environment variables passed through to git; everything else (all GIT_*) is dropped. */
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"] as const;

/** Scrubbed environment for the audit's git invocation. */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

/** `-c` overrides that win over any repo config, so nothing configured can run. */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.gitProxy=",
  "-c",
  "protocol.allow=never",
];

/** `<root>/.git` when it is a real directory (not a symlink, not a `gitdir:` pointer file). */
export function ownGitDir(root: string): string | undefined {
  const gitDir = join(root, ".git");
  try {
    return lstatSync(gitDir).isDirectory() ? gitDir : undefined;
  } catch {
    return undefined;
  }
}

/** "absent", "file" (regular, not a symlink) or "other" (FIFO, socket, device, dir, symlink). */
function fileKind(p: string): "absent" | "file" | "other" {
  try {
    return lstatSync(p).isFile() ? "file" : "other";
  } catch {
    return "absent";
  }
}

/** Files git may read for a work-tree command; each must be absent or a regular file. */
const PRECHECK = [".git/index", ".git/HEAD", ".git/info/exclude", ".gitignore"] as const;

/** `key\nvalue` entries of one config file, read by git itself (no includes, neutral cwd). */
function configEntries(file: string, timeout: number): { key: string; value: string }[] {
  const out = execFileSync(
    "git",
    [...HARDENED_GIT_CONFIG, "config", "--file", file, "--no-includes", "--list", "-z"],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: hardenedGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 << 20,
      timeout,
    },
  );
  return out
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const nl = e.indexOf("\n");
      return nl === -1 ? { key: e, value: "" } : { key: e.slice(0, nl), value: e.slice(nl + 1) };
    });
}

const resolveConfigPath = (value: string, gitDir: string) => {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : join(gitDir, value);
};

/**
 * Findings for the repository's own git setup: code-executing config keys, a `commondir`
 * redirect, unparseable config, and non-regular files where git would read (FIFOs block
 * git). Empty when there is no `<root>/.git` directory or nothing was found.
 */
export function gitConfigFindings(root: string, options: GitAuditOptions = {}): string[] {
  const gitDir = ownGitDir(root);
  if (!gitDir) return [];
  const bad: string[] = [];
  if (fileKind(join(gitDir, "commondir")) !== "absent") bad.push("commondir");
  for (const rel of PRECHECK)
    if (fileKind(join(root, rel)) === "other") bad.push(`${rel}:not-a-regular-file`);
  const configs: string[] = [];
  for (const name of ["config", "config.worktree"]) {
    const kind = fileKind(join(gitDir, name));
    if (kind === "other") bad.push(`.git/${name}:not-a-regular-file`);
    if (kind === "file") configs.push(name);
  }
  // Fail closed without touching git when anything git reads is not a regular file.
  if (bad.length) return bad;
  const deadline = Date.now() + (options.budgetMs ?? AUDIT_BUDGET_MS);
  const timedOut = () => {
    if (!bad.includes(AUDIT_TIMEOUT)) bad.push(AUDIT_TIMEOUT);
  };
  for (const name of configs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut();
      break;
    }
    let entries: { key: string; value: string }[];
    try {
      entries = configEntries(join(gitDir, name), remaining);
    } catch (e) {
      // A budget overrun is its own finding, never "unparseable" (a slow or loaded machine
      // says nothing about the config).
      const err = e as NodeJS.ErrnoException & { signal?: string | null };
      if (err.code === "ETIMEDOUT" || Date.now() >= deadline) {
        timedOut();
        break;
      }
      bad.push(`.git/${name}:unparseable`);
      continue;
    }
    for (const { key, value } of entries) {
      if (isDangerousGitKey(key) && !bad.includes(key)) bad.push(key);
      if (key.toLowerCase() === "core.excludesfile") {
        if (fileKind(resolveConfigPath(value, gitDir)) === "other")
          bad.push("core.excludesFile:not-a-regular-file");
      }
    }
  }
  return bad;
}

/**
 * Throws {@link UnsafeGitConfigError} (fail closed) when {@link gitConfigFindings} reports
 * anything. A repo without its own `.git` directory has nothing to audit.
 */
export function auditGitConfig(root: string, options: GitAuditOptions = {}): void {
  const bad = gitConfigFindings(root, options);
  if (bad.length) throw new UnsafeGitConfigError(bad);
}
