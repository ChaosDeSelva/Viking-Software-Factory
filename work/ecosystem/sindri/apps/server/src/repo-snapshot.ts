import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitConfigFindings, hardenedGitEnv, HARDENED_GIT_CONFIG } from "@sindri/knowledge";

const run = promisify(execFile);

/** What a planner is given to read for a project. */
export interface PlanningWorkspace {
  /** Directory the planner may read. */
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
}

/**
 * `core.hookspath` is the only code-running key tolerated in the repo's own config (husky sets
 * it); HARDENED_GIT_CONFIG pins it to /dev/null on both git calls made here.
 */
const HARDENED = [...HARDENED_GIT_CONFIG];
const TOLERATED_KEYS = new Set(["core.hookspath"]);
const COMPLETE = ".sindri-snapshot-complete";
const KIND = ".sindri-snapshot-kind";
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

/** A commit already in the repository, such as a delivered result. */
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

/**
 * A read-only copy of the project's default branch for the planner, so specs and plans describe
 * the code work will start from rather than whatever branch and uncommitted edits happen to be in
 * the operator's checkout. Only tracked files are exported, which also keeps local secrets such
 * as `.env` out of the planner's reach.
 *
 * Snapshots are keyed by commit and reused; older ones for the project are removed. No network
 * access: the branch is read as last fetched. Falls back to the working checkout (and says so in
 * the label) when the repository has no fetched default branch, has unsafe git config, or the
 * export fails, so planning never stops on a snapshot problem.
 */
export async function planningWorkspace(o: SnapshotOptions): Promise<PlanningWorkspace> {
  const checkout: PlanningWorkspace = {
    path: o.repoPath,
    label:
      "The working directory is the operator's working checkout. It may be on a feature branch, behind the default branch, and hold uncommitted edits.",
  };
  if (o.dataDir === null) return checkout;
  if (gitConfigFindings(o.repoPath).some((key) => !TOLERATED_KEYS.has(key.toLowerCase())))
    return checkout;
  const head = o.commit
    ? await commitHead(o.repoPath, o.commit)
    : await defaultBranchHead(o.repoPath);
  if (!head) return checkout;

  const projectDir = join(o.dataDir, "snapshots", o.projectId);
  const dir = join(projectDir, head.sha);
  const snapshot: PlanningWorkspace = {
    path: dir,
    label: o.commit
      ? `The working directory is a read-only snapshot of an already delivered change at commit ${head.sha.slice(0, 12)}. Work will start from this commit, not from the default branch. It has no git history.`
      : `The working directory is a read-only snapshot of ${head.ref} at commit ${head.sha.slice(0, 12)}, as last fetched. Work will start from this commit. It has no git history.`,
  };
  if (existsSync(join(dir, COMPLETE))) return snapshot;

  const staging = `${dir}.partial-${process.pid}-${Date.now()}`;
  const tar = `${staging}.tar`;
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await run("git", [...HARDENED, "archive", "--format=tar", "-o", tar, head.sha], {
      cwd: o.repoPath,
      env: gitEnv(),
      timeout: 300_000,
    });
    await run("tar", ["-xf", tar, "-C", staging], { timeout: 300_000 });
    await writeFile(join(staging, COMPLETE), `${head.ref} ${head.sha}\n`, { mode: 0o600 });
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch {
    await rm(staging, { recursive: true, force: true });
    // Another request may have finished the same snapshot while this one failed.
    return existsSync(join(dir, COMPLETE)) ? snapshot : checkout;
  } finally {
    await rm(tar, { force: true });
  }
  // One snapshot per kind is kept: a new default-branch snapshot replaces the old one and leaves
  // a rework's delivered-commit snapshot alone, and the other way round.
  const kind = o.commit ? "delivered" : "default";
  await writeFile(join(dir, KIND), kind, { mode: 0o600 });
  for (const name of await readdir(projectDir).catch(() => [] as string[])) {
    if (name === head.sha || name.includes(".partial-")) continue;
    const other = await readFile(join(projectDir, name, KIND), "utf8").catch(() => "default");
    if (other === kind) await rm(join(projectDir, name), { recursive: true, force: true });
  }
  return snapshot;
}
