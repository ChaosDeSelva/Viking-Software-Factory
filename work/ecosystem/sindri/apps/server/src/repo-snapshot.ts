import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitConfigFindings, hardenedGitEnv, HARDENED_GIT_CONFIG } from "@sindri/knowledge";

const run = promisify(execFile);

export interface PlanningWorkspace {
  path: string;
  /** One line telling the planner what the directory holds. */
  label: string;
}

export interface SnapshotOptions {
  /** Sindri data directory; snapshots live under `<dataDir>/snapshots`. `null` disables them. */
  dataDir: string | null;
  projectId: string;
  repoPath: string;
  /**
   * Snapshot this commit instead of the default branch: a rework is planned against the
   * delivered change it revises.
   */
  commit?: string;
  /** Other delivered commits the work also starts from, which the snapshot does not contain. */
  alsoStartsFrom?: readonly string[];
  now?: () => number;
}

/**
 * `core.hookspath` is the only code-running key tolerated in the repo's own config (husky sets
 * it); HARDENED_GIT_CONFIG pins it to /dev/null on both git calls made here.
 */
const HARDENED = [...HARDENED_GIT_CONFIG];
const TOLERATED_KEYS = new Set(["core.hookspath"]);
/**
 * `<sha>.complete` beside the snapshot directory marks a finished export. It is kept outside the
 * extracted tree on purpose: a repository can track a symlink under any name, and writing a
 * marker through one would overwrite a file of the repository author's choosing.
 */
const COMPLETE_SUFFIX = ".complete";
const complete = (dir: string) => `${dir}${COMPLETE_SUFFIX}`;
/** A snapshot unused for this long may be removed; a planner run holds one for minutes. */
const KEEP_MS = 6 * 60 * 60 * 1000;
const MAX_REF_OUTPUT = 4096;

function gitEnv(): NodeJS.ProcessEnv {
  // A snapshot is for reading source; never fetch large-file content over the network.
  return { ...hardenedGitEnv(), GIT_LFS_SKIP_SMUDGE: "1" };
}

async function git(repoPath: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await run("git", [...HARDENED, ...args], {
    cwd: repoPath,
    env: gitEnv(),
    timeout,
    maxBuffer: MAX_REF_OUTPUT,
  });
  return stdout.trim();
}

/** The repository's default branch as last fetched: `origin/main` and its commit. */
async function defaultBranchHead(repoPath: string): Promise<{ ref: string; sha: string } | null> {
  try {
    const ref = await git(
      repoPath,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      10_000,
    );
    const sha = await git(
      repoPath,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      10_000,
    );
    return /^[0-9a-f]{40,64}$/.test(sha) ? { ref, sha } : null;
  } catch {
    return null;
  }
}

function hasOwnGitDir(repoPath: string): boolean {
  try {
    return lstatSync(join(repoPath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

async function commitHead(
  repoPath: string,
  commit: string,
): Promise<{ ref: string; sha: string } | null> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) return null;
  try {
    const sha = await git(
      repoPath,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`],
      10_000,
    );
    return /^[0-9a-f]{40,64}$/.test(sha) ? { ref: sha, sha } : null;
  } catch {
    return null;
  }
}

/** Snapshot exports in flight, so concurrent requests for one commit share a single export. */
const exporting = new Map<string, Promise<boolean>>();

async function exportSnapshot(repoPath: string, sha: string, ref: string, dir: string) {
  const staging = `${dir}.partial-${process.pid}-${randomUUID()}`;
  const tar = `${staging}.tar`;
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await run("git", [...HARDENED, "archive", "--format=tar", "-o", tar, sha], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 300_000,
    });
    await run("tar", ["-xf", tar, "-C", staging], { timeout: 300_000 });
    // Never replace a finished snapshot: a planner may be reading it.
    if (!existsSync(complete(dir))) {
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      await writeFile(complete(dir), `${ref} ${sha}\n`, { mode: 0o600, flag: "wx" });
    }
    return true;
  } catch {
    return existsSync(complete(dir));
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(tar, { force: true });
  }
}

/** Removes the project's snapshots and abandoned staging directories nothing has used lately. */
async function prune(projectDir: string, keep: string, now: number): Promise<void> {
  for (const name of await readdir(projectDir).catch(() => [] as string[])) {
    if (name === keep || name.endsWith(COMPLETE_SUFFIX)) continue;
    const path = join(projectDir, name);
    // A snapshot's last use is its marker's mtime. Staging leftovers, and a snapshot another
    // request has just moved into place but not yet marked, have only their own.
    const mtime = (target: string) =>
      stat(target).then(
        (st) => st.mtimeMs,
        () => 0,
      );
    const used = Math.max(
      name.includes(".partial-") ? 0 : await mtime(complete(path)),
      await mtime(path),
    );
    if (now - used <= KEEP_MS) continue;
    await rm(complete(path), { force: true });
    await rm(path, { recursive: true, force: true });
  }
}

/** Removes every snapshot of a project (its data is being deleted). */
export async function removeSnapshots(dataDir: string | null, projectId: string): Promise<void> {
  if (dataDir !== null)
    await rm(join(dataDir, "snapshots", projectId), { recursive: true, force: true });
}

/**
 * A read-only copy of the project's default branch for the planner, so specs and plans describe
 * the code work starts from, not the branch and uncommitted edits in the operator's checkout.
 * Only tracked files are exported, which keeps local secrets such as `.env` out of the planner's
 * reach. Keyed by commit and reused; no network access (the branch is read as last fetched).
 *
 * Falls back to the working checkout, and says so in the label, when there is no fetched default
 * branch, the repo's git config is unsafe, or the export fails: planning never stops on this.
 */
export async function planningWorkspace(o: SnapshotOptions): Promise<PlanningWorkspace> {
  const checkout: PlanningWorkspace = {
    path: o.repoPath,
    label:
      "The working directory is the operator's working checkout. It may be on a feature branch, behind the default branch, and hold uncommitted edits.",
  };
  if (o.dataDir === null) return checkout;
  // The config audit only covers a repository with its own `.git` directory. A linked worktree
  // or submodule keeps its config elsewhere, so git is not run there at all.
  if (!hasOwnGitDir(o.repoPath)) return checkout;
  if (gitConfigFindings(o.repoPath).some((key) => !TOLERATED_KEYS.has(key.toLowerCase())))
    return checkout;
  const head = o.commit
    ? await commitHead(o.repoPath, o.commit)
    : await defaultBranchHead(o.repoPath);
  if (!head) return checkout;

  const now = (o.now ?? Date.now)();
  const projectDir = join(o.dataDir, "snapshots", o.projectId);
  const dir = join(projectDir, head.sha);
  const others = (o.alsoStartsFrom ?? []).filter((c) => c !== head.sha && c !== o.commit);
  const snapshot: PlanningWorkspace = {
    path: dir,
    label: o.commit
      ? `The working directory is a read-only snapshot of an already delivered change at commit ${head.sha.slice(0, 12)}. Work will start from this commit, not from the default branch. It has no git history.${
          others.length
            ? ` Work also starts from ${others.length} other delivered commit(s) (${others.map((c) => c.slice(0, 12)).join(", ")}) whose files are NOT in this directory; do not assume a file is missing from the delivered change because it is missing here.`
            : ""
        }`
      : `The working directory is a read-only snapshot of ${head.ref} at commit ${head.sha.slice(0, 12)}, as last fetched. Work will start from this commit. It has no git history.`,
  };
  if (!existsSync(complete(dir))) {
    let pending = exporting.get(dir);
    if (!pending) {
      pending = exportSnapshot(o.repoPath, head.sha, head.ref, dir).finally(() =>
        exporting.delete(dir),
      );
      exporting.set(dir, pending);
    }
    if (!(await pending)) return checkout;
  }
  // Mark it used, so pruning (here or in a later call) leaves a snapshot a planner is reading.
  const used = new Date(now);
  await utimes(complete(dir), used, used).catch(() => undefined);
  await prune(projectDir, head.sha, now).catch(() => undefined);
  return snapshot;
}
