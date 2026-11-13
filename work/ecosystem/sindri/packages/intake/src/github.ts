import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { containsSecret, redactSecrets } from "@sindri/knowledge";
import {
  ConnectorError,
  MAX_FIELD_CHARS,
  type Connector,
  type IssueRef,
  type IssueSnapshot,
} from "./connectors.js";

/**
 * Environment variables passed to `gh` and `git` (everything else is dropped). `gh` keeps its own
 * login (keychain or `~/.config/gh`), so Sindri never stores a GitHub token.
 */
export const GH_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "USER",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
];

/** Git config forced on every call: no hooks, no fsmonitor, no external helpers or transports. */
const GIT_HARDENING: readonly [string, string][] = [
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
 * Minimal, pinned environment for `gh` and `git` (the pattern of Mimir's PR runner): allowlisted
 * variables only, no system or global git config, hardening keys via `GIT_CONFIG_COUNT`, and no
 * prompts.
 */
export function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of GH_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GH_PROMPT_DISABLED"] = "1";
  env["GH_NO_UPDATE_NOTIFIER"] = "1";
  env["NO_COLOR"] = "1";
  env["GIT_CONFIG_COUNT"] = String(GIT_HARDENING.length);
  GIT_HARDENING.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Written to the child's stdin (never interpolated into a command line). */
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Runs one program with an argv array (no shell) under {@link ghEnv}. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_EXEC_MAX_BYTES = 8 * 1024 * 1024;

export class ExecError extends Error {
  override readonly name = "ExecError";
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** `execFile` with the hardened environment, a timeout, a size cap and optional stdin. */
export const hardenedExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd ?? tmpdir(),
        env: ghEnv(),
        timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: opts.maxBytes ?? DEFAULT_EXEC_MAX_BYTES,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          // stderr can echo remote text; keep only its end, with secrets redacted.
          const tail = redactSecrets(String(stderr ?? "").slice(-500)).text;
          reject(new ExecError(`${file} ${args[0] ?? ""} failed`, code, tail));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

/** The `gh` calls Sindri makes. Read calls only, except `postReview`. */
export interface GhClient {
  /** True when `gh` runs at all (installed and on PATH). */
  available(): Promise<boolean>;
  /** `gh pr view <url> --json ...`, parsed. */
  prView(url: string): Promise<unknown>;
  /**
   * `gh api -X POST repos/{o}/{r}/pulls/{n}/reviews --input -`: the JSON body goes on stdin.
   * Returns the created review (`id`, `html_url`).
   */
  postReview(
    pr: { owner: string; repo: string; number: number },
    body: unknown,
  ): Promise<{ id: number; htmlUrl: string }>;
  /**
   * `gh api repos/{o}/{r}/pulls/{n}/files --paginate` (GET): the changed files, which `gh pr view`
   * cuts at 100 (GitHub itself lists at most 3000).
   */
  listFiles(pr: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<{ path: string; additions: number | null; deletions: number | null }[]>;
  /** `gh api repos/{o}/{r}/pulls/{n}/reviews --paginate` (GET): every review of the PR. */
  listReviews(pr: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<{ id: number; htmlUrl: string; body: string }[]>;
}

export const PR_VIEW_FIELDS = [
  "number",
  "title",
  "body",
  "url",
  "author",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "isCrossRepository",
  "files",
  "changedFiles",
  "additions",
  "deletions",
  "state",
] as const;

const PR_VIEW_MAX_BYTES = 4 * 1024 * 1024;

/** {@link GhClient} over the real `gh` binary with {@link hardenedExec}. */
export function execGhClient(exec: ExecFn = hardenedExec): GhClient {
  let installed: Promise<boolean> | undefined;
  return {
    available() {
      installed ??= exec("gh", ["--version"], { timeoutMs: 10_000 }).then(
        () => true,
        () => false,
      );
      return installed;
    },
    async prView(url) {
      const { stdout } = await exec("gh", ["pr", "view", url, "--json", PR_VIEW_FIELDS.join(",")], {
        timeoutMs: 30_000,
        maxBytes: PR_VIEW_MAX_BYTES,
      });
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        throw new ConnectorError("gh pr view returned output that is not JSON");
      }
    },
    async postReview(pr, body) {
      const { stdout } = await exec(
        "gh",
        [
          "api",
          "-X",
          "POST",
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
          "--input",
          "-",
        ],
        { input: JSON.stringify(body), timeoutMs: 60_000, maxBytes: 1024 * 1024 },
      );
      const res = JSON.parse(stdout) as { id?: unknown; html_url?: unknown };
      if (typeof res.id !== "number" || typeof res.html_url !== "string")
        throw new Error("GitHub answered without a review id");
      return { id: res.id, htmlUrl: res.html_url };
    },
    async listFiles(pr) {
      const { stdout } = await exec(
        "gh",
        [
          "api",
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`,
          "--paginate",
          "--jq",
          ".[] | {filename, additions, deletions}",
        ],
        { timeoutMs: 120_000, maxBytes: 16 * 1024 * 1024 },
      );
      return stdout
        .split("\n")
        .filter((l) => l.trim())
        .map(
          (l) => JSON.parse(l) as { filename?: unknown; additions?: unknown; deletions?: unknown },
        )
        .filter((f) => typeof f.filename === "string")
        .map((f) => ({
          path: f.filename as string,
          additions: typeof f.additions === "number" ? f.additions : null,
          deletions: typeof f.deletions === "number" ? f.deletions : null,
        }));
    },
    async listReviews(pr) {
      // One compact JSON object per line, across every page.
      const { stdout } = await exec(
        "gh",
        [
          "api",
          `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
          "--paginate",
          "--jq",
          ".[] | {id, html_url, body}",
        ],
        { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 },
      );
      return stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { id?: unknown; html_url?: unknown; body?: unknown })
        .filter((r) => typeof r.id === "number" && typeof r.html_url === "string")
        .map((r) => ({
          id: r.id as number,
          htmlUrl: r.html_url as string,
          body: typeof r.body === "string" ? r.body : "",
        }));
    },
  };
}

// --------------------------------------------------------------------------------- PR URLs

/** GitHub owner and repository names: what GitHub itself allows. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** Canonical `https://github.com/<owner>/<repo>/pull/<n>`. */
  url: string;
}

/**
 * Parses `https://github.com/<owner>/<repo>/pull/<n>` (optionally with a trailing `/`, `/files`,
 * `/commits` or `/checks`, a query or a fragment). Any other host, scheme, port, credentials or
 * path is refused.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.port !== "") return null;
  if (u.username || u.password) return null;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})(?:\/(?:files|commits|checks)?)?\/?$/.exec(
    u.pathname,
  );
  if (!m) return null;
  const [, owner, repo, n] = m as unknown as [string, string, string, string];
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  const number = Number(n);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/**
 * `owner/repo` (lower case) of a GitHub remote URL: `https://github.com/o/r(.git)`,
 * `git@github.com:o/r(.git)` or `ssh://git@github.com/o/r(.git)`; null for anything else.
 */
export function githubRepoOfRemote(remote: string): string | null {
  const t = remote.trim();
  let path: string | null = null;
  const scp = /^[A-Za-z0-9._-]+@github\.com:(.+)$/.exec(t);
  if (scp) path = scp[1]!;
  else {
    try {
      const u = new URL(t);
      if (
        u.hostname.toLowerCase() === "github.com" &&
        ["https:", "http:", "ssh:", "git:"].includes(u.protocol)
      )
        path = u.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  if (!path) return null;
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(path);
  if (!m || !OWNER.test(m[1]!) || !REPO.test(m[2]!)) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

// ------------------------------------------------------------------------------- Connector

const SHA = /^[0-9a-f]{40}$/;
/** GitHub lists at most this many changed files of a pull request. */
export const MAX_PR_FILES = 3000;
/** Bytes of file paths kept in the snapshot, which must stay well under the raw payload cap. */
const MAX_FILE_PATH_BYTES = 160 * 1024;

/** The PR facts a review needs, as stored in the intake's `raw` snapshot. */
export interface PullRequestMeta {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string | null;
  state: string | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  additions: number | null;
  deletions: number | null;
  files: { path: string; additions: number | null; deletions: number | null }[];
  /** Changed files GitHub counts (null when unknown). */
  changedFiles: number | null;
  /** Changed files not in `files` (GitHub's 3000-file cap, or the snapshot's size budget). */
  filesOmitted: number;
  /** True when the body held something that looks like a credential (it was redacted). */
  secretsRedacted: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const cap = (text: string) =>
  text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) : text;

/** Reads `gh pr view --json` output into {@link PullRequestMeta}; refuses malformed SHAs. */
export function pullRequestMeta(
  ref: PullRequestRef,
  raw: unknown,
  listed?: readonly { path: string; additions: number | null; deletions: number | null }[],
): PullRequestMeta {
  const r = rec(raw);
  const baseRefOid = str(r["baseRefOid"]) ?? "";
  const headRefOid = str(r["headRefOid"]) ?? "";
  if (!SHA.test(baseRefOid) || !SHA.test(headRefOid))
    throw new ConnectorError("gh pr view returned no valid base or head commit");
  if (num(r["number"]) !== null && num(r["number"]) !== ref.number)
    throw new ConnectorError("gh pr view returned a different pull request");
  const all = (
    listed ??
    (Array.isArray(r["files"]) ? r["files"] : []).map(rec).map((f) => ({
      path: str(f["path"]) ?? "",
      additions: num(f["additions"]),
      deletions: num(f["deletions"]),
    }))
  )
    .slice(0, MAX_PR_FILES)
    .filter((f) => f.path && f.path.length <= 1000 && !/[\0\n]/.test(f.path));
  const files: PullRequestMeta["files"] = [];
  let bytes = 0;
  for (const f of all) {
    bytes += Buffer.byteLength(f.path, "utf8") + 48;
    if (bytes > MAX_FILE_PATH_BYTES) break;
    files.push({ path: f.path, additions: f.additions, deletions: f.deletions });
  }
  const changedFiles = num(r["changedFiles"]);
  const filesOmitted = Math.max(0, (changedFiles ?? all.length) - files.length);
  const title = redactSecrets(cap(str(r["title"]) ?? "")).text;
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: ref.url,
    title,
    author: str(rec(r["author"])["login"]) ?? null,
    state: str(r["state"]) ?? null,
    baseRefName: str(r["baseRefName"])?.slice(0, 255) ?? "",
    baseRefOid,
    headRefName: str(r["headRefName"])?.slice(0, 255) ?? "",
    headRefOid,
    isCrossRepository: r["isCrossRepository"] === true,
    additions: num(r["additions"]),
    deletions: num(r["deletions"]),
    files,
    changedFiles,
    filesOmitted,
    secretsRedacted: containsSecret(str(r["body"]) ?? "") || containsSecret(str(r["title"]) ?? ""),
  };
}

/**
 * Read-only GitHub pull requests through the operator's own `gh` login. The PR title and body are
 * untrusted: they are capped, secrets are redacted, and the stored snapshot's `raw` holds only
 * {@link PullRequestMeta} (no body).
 */
export class GitHubPrConnector implements Connector {
  readonly kind = "github" as const;
  constructor(private readonly gh: GhClient) {}

  canHandle(url: string): boolean {
    return parsePullRequestUrl(url) !== null;
  }

  parseUrl(url: string): IssueRef {
    const ref = parsePullRequestUrl(url);
    if (!ref) throw new ConnectorError("not a GitHub pull request URL");
    return { source: "github", key: `${ref.owner}/${ref.repo}#${ref.number}`, url: ref.url };
  }

  async fetchIssue(ref: IssueRef): Promise<IssueSnapshot> {
    const pr = parsePullRequestUrl(ref.url);
    if (!pr) throw new ConnectorError("not a GitHub pull request URL");
    if (!(await this.gh.available()))
      throw new ConnectorError("gh is not installed; install the GitHub CLI and run gh auth login");
    let raw: unknown;
    try {
      raw = await this.gh.prView(pr.url);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      throw new ConnectorError("gh pr view failed; check that gh is installed and logged in");
    }
    // `gh pr view` lists at most 100 files; the files API pages up to GitHub's 3000.
    let listed;
    try {
      listed = await this.gh.listFiles(pr);
    } catch {
      listed = undefined;
    }
    const meta = pullRequestMeta(pr, raw, listed);
    const body = redactSecrets(cap(str(rec(raw)["body"]) ?? "")).text;
    return {
      source: "github",
      externalId: `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(),
      url: pr.url,
      title: meta.title,
      body,
      // The head commit: a re-import after a push is a new version of the PR.
      updated: meta.headRefOid,
      ...(meta.state ? { status: meta.state } : {}),
      raw: { pullRequest: meta },
    };
  }
}

/** The PR facts of a GitHub intake's stored snapshot, or null for any other intake. */
export function pullRequestOfSnapshot(raw: unknown): PullRequestMeta | null {
  const pr = rec(rec(raw)["pullRequest"]);
  if (typeof pr["owner"] !== "string" || !SHA.test(String(pr["headRefOid"] ?? ""))) return null;
  return pr as unknown as PullRequestMeta;
}
