import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PrDiffReader, PrReviewView } from "@sindri/delivery";
import { githubRepoOfRemote, hardenedExec, type ExecFn } from "@sindri/intake";
import { HARDENED_GIT_CONFIG, hardenedGitEnv, type SqliteDatabase } from "@sindri/knowledge";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SHA = /^[0-9a-f]{40}$/;
/** Project ids that may name a mirror directory. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Git config for talking to GitHub from the mirror: only https, and the operator's own `gh` login
 * as the credential helper (the hardened environment empties every other helper).
 */
export const MIRROR_GIT_CONFIG: readonly string[] = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "advice.detachedHead=false",
];

/** Bumped when {@link MIRROR_LOCAL_CONFIG} changes, so existing mirrors are configured again. */
export const MIRROR_CONFIG_VERSION = "1";

/**
 * Config written into the mirror's own `.git/config`, so later git runs in it (Mimir's worktrees
 * fetching missing blobs of the partial clone, for a private repository too) use the operator's
 * `gh` login and nothing else: inherited credential helpers are reset first. No hooks, no
 * fsmonitor, no submodules, https only.
 */
export const MIRROR_LOCAL_CONFIG: readonly (readonly [string, string])[] = [
  ["credential.helper", ""],
  ["credential.https://github.com.helper", "!gh auth git-credential"],
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["submodule.recurse", "false"],
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
  ["sindri.mirrorConfig", MIRROR_CONFIG_VERSION],
];

/** A pull request's refs are kept this long after their last fetch, for at most this many PRs. */
export const MIRROR_REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MIRROR_MAX_PRS = 20;

/** The refs a pull request's commits are kept under in the mirror. */
export const mirrorRefs = (n: number) => ({
  head: `refs/sindri/pr/${n}/head`,
  base: `refs/sindri/pr/${n}/base`,
  baseBranch: `refs/sindri/pr/${n}/base-branch`,
});

export class MirrorError extends Error {
  override readonly name = "MirrorError";
  constructor(
    readonly reason:
      | "fetch_failed"
      | "clone_failed"
      | "commit_missing"
      | "invalid_pr"
      | "blobs_missing"
      | "no_data_dir",
    message: string,
  ) {
    super(message);
  }
}

export interface MirrorRecord {
  projectId: string;
  repo: string;
  path: string;
  mimirProjectId: string | null;
}

export interface ReviewMirrorOptions {
  db: SqliteDatabase;
  /** Sindri's data directory; mirrors live in `<dataDir>/review-mirrors/<projectId>`. */
  dataDir: string | null;
  exec?: ExecFn;
  now?: () => Date;
}

/**
 * A factory-owned partial clone of a project's GitHub repository, used only for PR reviews, so
 * nothing is written to the operator's checkout. Created with `git clone --no-checkout
 * --filter=blob:none` from the canonical https URL, then the PR's base and head commits are
 * fetched (falling back to `refs/pull/<n>/head`) and checked out at the head, which brings in the
 * blobs Mimir's worktree and the diff need. One operation per project at a time.
 */
/** What the server needs from a review mirror (a fake in tests). */
export interface ReviewMirrorService extends PrDiffReader {
  prepare(projectId: string, pr: PrReviewView): Promise<MirrorRecord>;
  get(projectId: string): MirrorRecord | null;
  setMimirProject(projectId: string, mimirProjectId: string): void;
  remove(projectId: string): void;
}

export class ReviewMirror implements ReviewMirrorService {
  readonly #o: ReviewMirrorOptions;
  readonly #exec: ExecFn;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(o: ReviewMirrorOptions) {
    this.#o = o;
    this.#exec = o.exec ?? hardenedExec;
  }

  pathFor(projectId: string): string {
    if (!this.#o.dataDir) throw new MirrorError("no_data_dir", "Sindri has no data directory");
    if (!PROJECT_ID.test(projectId)) throw new MirrorError("invalid_pr", "invalid project id");
    return join(this.#o.dataDir, "review-mirrors", projectId);
  }

  get(projectId: string): MirrorRecord | null {
    const r = this.#o.db
      .prepare(
        "SELECT project_id, repo, path, mimir_project_id FROM review_mirrors WHERE project_id = ?",
      )
      .get(projectId) as
      | { project_id: string; repo: string; path: string; mimir_project_id: string | null }
      | undefined;
    return r
      ? { projectId: r.project_id, repo: r.repo, path: r.path, mimirProjectId: r.mimir_project_id }
      : null;
  }

  /** Remembers the hidden Mimir project registered for the mirror. */
  setMimirProject(projectId: string, mimirProjectId: string): void {
    this.#o.db
      .prepare(
        "UPDATE review_mirrors SET mimir_project_id = ?, updated_at = ? WHERE project_id = ?",
      )
      .run(mimirProjectId, this.#iso(), projectId);
  }

  /** Runs `fn` after every earlier operation on the project's mirror has settled. */
  #serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#queues.set(projectId, tail);
    void tail.then(() => {
      if (this.#queues.get(projectId) === tail) this.#queues.delete(projectId);
    });
    return next;
  }

  #iso() {
    return (this.#o.now ?? (() => new Date()))().toISOString();
  }

  #git(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; maxBytes?: number; input?: string } = {},
  ) {
    return this.#exec("git", [...MIRROR_GIT_CONFIG, ...args], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
  }

  async #hasCommit(path: string, sha: string): Promise<boolean> {
    try {
      await this.#git(path, ["cat-file", "-e", `${sha}^{commit}`], { timeoutMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Makes the mirror hold the PR's base and head commits and returns its path. Clones on first
   * use (or when the project now points at another repository).
   */
  prepare(projectId: string, pr: PrReviewView): Promise<MirrorRecord> {
    if (!SHA.test(pr.baseSha) || !SHA.test(pr.headSha) || !Number.isSafeInteger(pr.number))
      return Promise.reject(new MirrorError("invalid_pr", "invalid pull request commits"));
    const repo = `${pr.owner}/${pr.repo}`.toLowerCase();
    if (githubRepoOfRemote(`https://github.com/${repo}`) !== repo)
      return Promise.reject(new MirrorError("invalid_pr", "invalid repository name"));
    return this.#serial(projectId, async () => {
      const path = this.pathFor(projectId);
      const existing = this.get(projectId);
      const fresh = !existing || existing.repo !== repo || !existsSync(join(path, ".git"));
      if (fresh) {
        rmSync(path, { recursive: true, force: true });
        mkdirSync(join(path, ".."), { recursive: true });
        try {
          await this.#git(join(path, ".."), [
            "clone",
            "--no-checkout",
            "--filter=blob:none",
            "--",
            `https://github.com/${repo}.git`,
            path,
          ]);
        } catch {
          rmSync(path, { recursive: true, force: true });
          throw new MirrorError("clone_failed", `could not clone ${repo}`);
        }
        const at = this.#iso();
        this.#o.db.prepare("DELETE FROM review_mirrors WHERE project_id = ?").run(projectId);
        this.#o.db
          .prepare(
            `INSERT INTO review_mirrors (project_id, repo, path, mimir_project_id, hidden, created_at,
               updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET repo = excluded.repo, path = excluded.path,
               mimir_project_id = NULL, updated_at = excluded.updated_at`,
          )
          .run(projectId, repo, path, at, at);
      }
      await this.#configure(path);
      const have = async () =>
        (await this.#hasCommit(path, pr.baseSha)) && (await this.#hasCommit(path, pr.headSha));
      let present = await have();
      if (!present) {
        try {
          await this.#git(path, ["fetch", "--no-tags", "origin", pr.baseSha, pr.headSha]);
        } catch {
          // Servers that refuse fetching a bare SHA still serve the PR's ref.
          try {
            await this.#git(path, [
              "fetch",
              "--no-tags",
              "origin",
              `+refs/pull/${pr.number}/head:${mirrorRefs(pr.number).head}`,
              ...(/^[A-Za-z0-9._/-]{1,255}$/.test(pr.baseRef) && !pr.baseRef.includes("..")
                ? [`+refs/heads/${pr.baseRef}:${mirrorRefs(pr.number).baseBranch}`]
                : []),
            ]);
          } catch {
            throw new MirrorError("fetch_failed", `could not fetch pull request ${pr.number}`);
          }
        }
        present = await have();
      }
      if (!present)
        throw new MirrorError(
          "commit_missing",
          "the pull request's base or head commit is missing",
        );
      // Refs keep both commits from garbage collection until they are pruned.
      const refs = mirrorRefs(pr.number);
      await this.#git(path, ["update-ref", refs.head, pr.headSha]);
      await this.#git(path, ["update-ref", refs.base, pr.baseSha]);
      await this.#prune(projectId, path, pr.number);
      // Brings in the head's blobs (with gh credentials) before Mimir adds its worktree.
      await this.#git(path, ["checkout", "--detach", "--force", pr.headSha]);
      await this.#faultInBlobs(path, pr);
      return this.get(projectId) as MirrorRecord;
    });
  }

  /**
   * Fetches, while Sindri still has `gh` credentials, every blob a reviewer reads: both sides of
   * each changed file (`git diff base...head` reads them) and, through the checkout, every file at
   * the head. Then checks without fetching (`rev-list --missing=print`) that none is missing, so
   * Mimir's agent never needs a lazy fetch. Unchanged files at the base may stay absent.
   */
  async #faultInBlobs(path: string, pr: PrReviewView): Promise<void> {
    const range = `${pr.baseSha}...${pr.headSha}`;
    await this.#git(path, ["diff", "--no-ext-diff", "--binary", "--output=/dev/null", range]);
    const raw = await this.#git(path, ["diff", "--raw", "--no-abbrev", "-z", range], {
      maxBytes: 64 * 1024 * 1024,
    });
    const needed = new Set<string>([pr.headSha]);
    for (const entry of raw.stdout.split("\0"))
      if (entry.startsWith(":"))
        for (const sha of entry.split(" ").slice(2, 4))
          if (SHA.test(sha) && !/^0+$/.test(sha)) needed.add(sha);
    const { stdout } = await this.#git(
      path,
      ["rev-list", "--objects", "--missing=print", "--no-walk", "--stdin"],
      { input: `${[...needed].join("\n")}\n`, maxBytes: 256 * 1024 * 1024 },
    );
    const missing = stdout.split("\n").filter((l) => l.startsWith("?")).length;
    if (missing > 0)
      throw new MirrorError(
        "blobs_missing",
        `${missing} file version(s) of the pull request could not be fetched`,
      );
  }

  /** Writes {@link MIRROR_LOCAL_CONFIG} unless the mirror already has this version of it. */
  async #configure(path: string): Promise<void> {
    let current: string;
    try {
      current = (
        await this.#git(path, ["config", "--local", "--get", "sindri.mirrorConfig"], {
          timeoutMs: 15_000,
        })
      ).stdout.trim();
    } catch {
      current = "";
    }
    if (current === MIRROR_CONFIG_VERSION) return;
    for (const [key, value] of MIRROR_LOCAL_CONFIG)
      await this.#git(path, ["config", "--local", "--replace-all", key, value], {
        timeoutMs: 15_000,
      });
  }

  /**
   * Records this PR's fetch and deletes the refs of PRs fetched more than 30 days ago, or beyond
   * the 20 most recently fetched.
   */
  async #prune(projectId: string, path: string, number: number): Promise<void> {
    const row = this.#o.db
      .prepare("SELECT pr_refs_json FROM review_mirrors WHERE project_id = ?")
      .get(projectId) as { pr_refs_json: string } | undefined;
    const fetched = JSON.parse(row?.pr_refs_json ?? "{}") as Record<string, string>;
    const now = (this.#o.now ?? (() => new Date()))();
    fetched[String(number)] = now.toISOString();
    const newest = Object.entries(fetched).sort((a, b) => b[1].localeCompare(a[1]));
    const drop = newest.filter(
      ([n, at], i) =>
        n !== String(number) &&
        (i >= MIRROR_MAX_PRS || now.getTime() - Date.parse(at) > MIRROR_REF_MAX_AGE_MS),
    );
    for (const [n] of drop) {
      for (const ref of Object.values(mirrorRefs(Number(n))))
        await this.#git(path, ["update-ref", "-d", ref], { timeoutMs: 15_000 }).catch(
          () => undefined,
        );
      delete fetched[n];
    }
    this.#o.db
      .prepare("UPDATE review_mirrors SET pr_refs_json = ?, updated_at = ? WHERE project_id = ?")
      .run(JSON.stringify(fetched), now.toISOString(), projectId);
  }

  /**
   * `git diff --unified=0 base...head` in the project's mirror: the change since the merge base,
   * as GitHub shows a pull request (so a base branch that moved on adds nothing), with the merge
   * base its LEFT-side lines refer to.
   */
  async diff(projectId: string, pr: PrReviewView): Promise<{ diff: string; mergeBaseSha: string }> {
    if (!SHA.test(pr.baseSha) || !SHA.test(pr.headSha))
      throw new MirrorError("invalid_pr", "invalid pull request commits");
    const mirror = this.get(projectId);
    if (!mirror) throw new MirrorError("commit_missing", "no review mirror for this project");
    return this.#serial(projectId, async () => {
      const mergeBaseSha = (
        await this.#git(mirror.path, ["merge-base", pr.baseSha, pr.headSha], {
          timeoutMs: 60_000,
        })
      ).stdout.trim();
      if (!SHA.test(mergeBaseSha))
        throw new MirrorError("commit_missing", "the pull request has no merge base");
      const { stdout } = await this.#git(
        mirror.path,
        [
          "diff",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          `${pr.baseSha}...${pr.headSha}`,
          "--",
        ],
        { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 },
      );
      return { diff: stdout, mergeBaseSha };
    });
  }

  /** Removes a project's mirror directory (project purge; its row goes with the project). */
  remove(projectId: string): void {
    if (!this.#o.dataDir || !PROJECT_ID.test(projectId)) return;
    rmSync(this.pathFor(projectId), { recursive: true, force: true });
  }
}

const run = promisify(execFile);

/**
 * `owner/repo` of every GitHub remote of a repository, read with `git remote -v` under the
 * hardened git config (nothing the repository configures can run).
 */
export async function githubReposOf(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", [...HARDENED_GIT_CONFIG, "remote", "-v"], {
      cwd: repoPath,
      env: hardenedGitEnv(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const repos = stdout
      .split("\n")
      .map((l) => l.split(/\s+/)[1] ?? "")
      .map(githubRepoOfRemote)
      .filter((r): r is string => r !== null);
    return [...new Set(repos)];
  } catch {
    return [];
  }
}

/**
 * GitHub repositories per project checkout, looked up at most `concurrency` at a time and cached
 * for `ttlMs` per project and path (a remote changed on disk shows up after that).
 */
export function cachedRemoteLookup(
  lookup: (repoPath: string) => Promise<string[]> = githubReposOf,
  { ttlMs = 60_000, concurrency = 4, now = () => Date.now() } = {},
) {
  const cache = new Map<string, { at: number; repos: Promise<string[]> }>();
  return async function reposOf(
    projects: readonly { id: string; repoPath: string }[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    let next = 0;
    const worker = async () => {
      while (next < projects.length) {
        const p = projects[next++]!;
        const key = `${p.id}\0${p.repoPath}`;
        let hit = cache.get(key);
        if (!hit || now() - hit.at > ttlMs) {
          hit = { at: now(), repos: lookup(p.repoPath).catch(() => []) };
          cache.set(key, hit);
        }
        out.set(p.id, await hit.repos);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
    return out;
  };
}
