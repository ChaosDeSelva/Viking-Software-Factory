import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  MimirError,
  GitShaSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TimestampSchema,
  WorktreeSchema,
  newId,
  type ApprovalId,
  type ProjectId,
  type TaskId,
  type Worktree,
  type WorktreeId,
} from "@mimir/protocol";
import { z } from "zod";
import { assertRefArg, auditRepoConfig, git, resolveCommit } from "./git.js";
import {
  assertNoSymlinkBelow,
  assertSafeAbsolutePath,
  assertSlug,
  branchNameFor,
  isInside,
} from "./paths.js";
import { protectedBranchGuard, type ProtectedBranchGuard } from "./protected.js";
import { runTests, type RunTestsOptions, type RunTestsResult } from "./run-tests.js";
import { ScratchRepo } from "./scratch.js";

/**
 * Ownership claim file written at the root of every managed worktree (git-ignored via
 * info/exclude). It lives in agent-writable space, so it is advisory: it is schema-validated on
 * every read and the server's persisted Worktree record stays authoritative.
 */
export const OWNER_FILE = ".mimir-owner.json";
/**
 * Default worktree root. Deliberately outside Mimir's data dir (`~/.mimir`), which holds the
 * operator token: an agent's worktree must not sit next to it (audit H1).
 */
export const DEFAULT_WORKTREE_ROOT = join(homedir(), ".mimir-work", "worktrees");
/** Mimir's default data dir; worktree roots are refused inside it. */
const DEFAULT_DATA_DIR = join(homedir(), ".mimir");

/** `MIMIR_WORKTREE_ROOT` when set, else `DEFAULT_WORKTREE_ROOT`. */
export function defaultWorktreeRoot(env: Record<string, string | undefined> = process.env): string {
  const v = env["MIMIR_WORKTREE_ROOT"]?.trim();
  return v === undefined || v === "" ? DEFAULT_WORKTREE_ROOT : v;
}

function defaultDataDirs(env: Record<string, string | undefined> = process.env): string[] {
  const v = env["MIMIR_DATA_DIR"]?.trim();
  return v === undefined || v === "" ? [DEFAULT_DATA_DIR] : [DEFAULT_DATA_DIR, v];
}

function assertOutsideDataDirs(root: string, dataDirs: readonly string[]): void {
  for (const d of dataDirs) {
    if (isAbsolute(d) && isInside(root, resolve(d))) {
      throw new MimirError(
        "validation_failed",
        "worktree root must not be inside the Mimir data dir (it holds the operator token)",
        { worktreeRoot: root, dataDir: d },
      );
    }
  }
}
/** Directory under the worktree root holding Mimir's private scratch repositories. */
export const SCRATCH_DIR = ".mimir-scratch";

export const OwnerClaimSchema = z.object({
  taskId: TaskIdSchema,
  sessionId: z.string().min(1).max(200).optional(),
  createdAt: TimestampSchema,
});

export interface GitManagerOptions {
  /** Directory holding all worktrees. Default `$MIMIR_WORKTREE_ROOT` or `~/.mimir-work/worktrees`. */
  worktreeRoot?: string;
  /**
   * Directories the worktree root must not be inside (Mimir's data dir, which holds the operator
   * token), in addition to `~/.mimir` and `$MIMIR_DATA_DIR`, which always apply.
   */
  dataDirs?: readonly string[];
  /** Branch rules the manager will never create or delete (trailing `*` wildcard). */
  protectedBranches?: string[];
  /** Whether a session holding a claim is still alive. Default: always live (fail-closed). */
  isSessionLive?: (sessionId: string) => boolean | Promise<boolean>;
  /**
   * Whether a task owning a worktree is still alive. Default: live unless this manager knows the
   * task's worktree was removed; unknown tasks are treated as live (fail-closed).
   */
  isTaskLive?: (taskId: string) => boolean | Promise<boolean>;
}

export interface RegisterProjectInput {
  projectId: ProjectId;
  repoPath: string;
}

export interface CreateWorktreeInput {
  projectId: ProjectId;
  repoPath: string;
  taskId: TaskId;
  crewSlug: string;
  taskSlug: string;
  /** Ref the branch starts from. Default: the repository's default branch. */
  baseRef?: string;
}

export interface OwnerClaim {
  taskId: string;
  sessionId?: string;
  createdAt: string;
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  /** Required with `force`; recorded in the result only (the caller verifies and audits it). */
  approvalId?: ApprovalId | string;
}

export interface RemoveWorktreeResult {
  worktree: Worktree;
  removed: true;
  forced: boolean;
  branchDeleted: boolean;
  approvalId?: string;
  /** Set when the worktree was removed but deleting its merged branch failed. */
  branchDeleteError?: string;
}

export interface DiffOptions {
  /**
   * Also include uncommitted, staged and untracked (non-ignored) changes. Content is hashed as
   * raw bytes (no clean filters), so LFS pointers / CRLF appear as stored on disk.
   */
  includeWorkingTree?: boolean;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "typechange" | "unknown";

export interface DiffFile {
  path: string;
  status: FileChangeStatus;
  /** Line counts; 0 for binary files. */
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  baseSha: string;
  /** Commit the committed part of the diff ends at. */
  headSha: string;
  /** True when working-tree changes were included. */
  includesWorkingTree: boolean;
  /** True when included working-tree changes differ from `headSha` (the diff is not a commit). */
  dirty: boolean;
  files: DiffFile[];
  patch: string;
}

export interface ChangedFilesManifest {
  worktreeId: WorktreeId;
  baseSha: string;
  headSha: string;
  includesWorkingTree: boolean;
  dirty: boolean;
  files: { path: string; status: FileChangeStatus }[];
}

export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export interface ConflictReport {
  clean: boolean;
  conflicts: string[];
  targetSha: string;
  headSha: string;
}

/** A persisted Worktree row, optionally with the base ref it was created from. */
export type RestoreRecord = Worktree & { baseRef?: string };

export interface RestoreResult {
  restored: Worktree[];
  rejected: { worktree: unknown; reason: string }[];
}

interface Record_ {
  worktree: Worktree;
  projectId: ProjectId;
  repoPath: string;
  baseRef: string;
}

const STATUS_CODES: Record<string, FileChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typechange",
};

const DIFF_FLAGS = ["--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Owns the lifecycle of per-task git worktrees. There is intentionally no push, merge or checkout
 * of existing branches here; integrating work is an approval-gated server flow.
 *
 * Security model: agents can write their worktree and (absent OS sandboxing) the project's shared
 * `.git`. Every git call uses an allowlisted environment and hardening `-c` flags. Commands that
 * must run in the project (worktree add/remove, status) are preceded by a fail-closed audit of the
 * repo config. Read-only analysis runs in a Mimir-owned scratch repo that only borrows objects.
 */
export class GitManager {
  readonly worktreeRoot: string;
  private readonly protectedRules: string[];
  private readonly isSessionLive: (sessionId: string) => boolean | Promise<boolean>;
  private readonly isTaskLiveOpt: ((taskId: string) => boolean | Promise<boolean>) | undefined;
  private readonly projects = new Map<string, string>();
  private readonly records = new Map<string, Record_>();
  private readonly scratches = new Map<string, Promise<ScratchRepo>>();
  private realRoot: string | undefined;
  private readonly dataDirs: readonly string[];

  constructor(options: GitManagerOptions = {}) {
    this.worktreeRoot = assertSafeAbsolutePath(
      options.worktreeRoot ?? defaultWorktreeRoot(),
      "worktreeRoot",
    );
    this.dataDirs = [...defaultDataDirs(), ...(options.dataDirs ?? [])];
    assertOutsideDataDirs(this.worktreeRoot, this.dataDirs);
    this.protectedRules = [...(options.protectedBranches ?? [])];
    this.isSessionLive = options.isSessionLive ?? (() => true);
    this.isTaskLiveOpt = options.isTaskLive;
  }

  /** Guard for `repoPath` using this manager's protected-branch rules. */
  guard(repoPath: string): ProtectedBranchGuard {
    return protectedBranchGuard(repoPath, { protected: this.protectedRules });
  }

  /**
   * Validates and registers a project clone: it must be the top level of a non-bare git work tree,
   * is resolved through realpath, must not live under the worktree root, and must not contain the
   * worktree root. Returns the real path.
   */
  async registerProject(input: RegisterProjectInput): Promise<string> {
    const projectId = this.parseId(ProjectIdSchema, input.projectId, "projectId");
    const given = assertSafeAbsolutePath(input.repoPath, "repoPath");
    const real = await realpath(given).catch(() => {
      throw new MimirError("validation_failed", "repoPath does not exist", { repoPath: given });
    });
    const top = await git(real, ["rev-parse", "--is-bare-repository", "--show-toplevel"], {
      okExitCodes: [128],
    });
    const [bare, toplevel] = top.stdout.trim().split("\n");
    if (top.exitCode !== 0 || bare !== "false" || !toplevel) {
      throw new MimirError("validation_failed", "repoPath is not a git work tree", {
        repoPath: real,
      });
    }
    if ((await realpath(toplevel)) !== real) {
      throw new MimirError("validation_failed", "repoPath must be the repository top level", {
        repoPath: real,
        toplevel,
      });
    }
    const rootReal = await this.resolveRootForCheck();
    if (isInside(real, rootReal)) {
      throw new MimirError("validation_failed", "repoPath must not be under the worktree root", {
        repoPath: real,
        worktreeRoot: rootReal,
      });
    }
    for (const repo of [real, ...this.projects.values()]) {
      if (isInside(rootReal, repo)) {
        throw new MimirError(
          "validation_failed",
          "worktree root must not be inside a project clone",
          { repoPath: repo, worktreeRoot: rootReal },
        );
      }
    }
    this.projects.set(projectId, real);
    return real;
  }

  async createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
    const projectId = this.parseId(ProjectIdSchema, input.projectId, "projectId");
    const taskId = this.parseId(TaskIdSchema, input.taskId, "taskId");
    assertSlug(input.crewSlug, "crewSlug");
    assertSlug(input.taskSlug, "taskSlug");
    if (input.baseRef !== undefined) assertRefArg(input.baseRef, "baseRef");

    const repoPath = await this.registerProject({ projectId, repoPath: input.repoPath });
    await auditRepoConfig(repoPath);
    const branch = branchNameFor(input.crewSlug, taskId, input.taskSlug);
    this.guard(repoPath).assertNotProtected(branch);
    await git(repoPath, ["check-ref-format", "--branch", branch]).catch(() => {
      throw new MimirError("validation_failed", "invalid branch name", { branch });
    });
    if (await this.branchExists(repoPath, branch)) {
      throw new MimirError("conflict", `branch '${branch}' already exists`, { branch });
    }

    const baseRef = input.baseRef ?? (await this.defaultBranch(repoPath));
    const baseSha = await resolveCommit(repoPath, baseRef, "baseRef");

    const root = await this.ensureRoot();
    const projectDir = join(root, projectId);
    const path = join(projectDir, taskId);
    await assertNoSymlinkBelow(root, path);
    if (await lstat(path).catch(() => undefined)) {
      throw new MimirError("conflict", "worktree path already exists", { path });
    }
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    await assertNoSymlinkBelow(root, path);

    await git(repoPath, ["worktree", "add", "--no-track", "-b", branch, path, baseSha]);
    if ((await realpath(path)) !== path) {
      await git(repoPath, ["worktree", "remove", "--force", path]).catch(() => undefined);
      throw new MimirError("validation_failed", "worktree path resolved through a symlink", {
        path,
      });
    }
    await this.ensureOwnerFileIgnored(repoPath);
    const claim: OwnerClaim = { taskId, createdAt: nowIso() };
    await writeFile(join(path, OWNER_FILE), `${JSON.stringify(claim, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    const ts = nowIso();
    const worktree: Worktree = {
      id: newId("wtr"),
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      taskId,
      path,
      branch,
      baseSha,
      status: "active",
    };
    this.records.set(worktree.id, { worktree, projectId, repoPath, baseRef });
    return { ...worktree };
  }

  /**
   * Re-adopts persisted records after a restart. Rows are not trusted: each must parse as a
   * Worktree, sit at `<root>/<projectId>/<taskId>` for a project registered with this manager
   * (no symlinks), be listed by `git worktree list` on its branch, carry a valid owner file for
   * its task, and have a resolvable `baseSha`. Removed records are kept as removed. The record's
   * persisted `baseRef` (see {@link baseRefOf}) is kept; without one, the project's default
   * branch is used.
   */
  async restore(records: RestoreRecord[]): Promise<RestoreResult> {
    const restored: Worktree[] = [];
    const rejected: RestoreResult["rejected"] = [];
    const listings = new Map<string, Map<string, string>>();
    for (const raw of records) {
      try {
        const worktree = WorktreeSchema.parse(raw);
        if (this.records.has(worktree.id)) throw new Error("duplicate worktree id");
        const root = await this.ensureRoot();
        const path = assertSafeAbsolutePath(worktree.path, "path");
        const projectId = basename(dirname(path));
        const repoPath = this.projects.get(projectId);
        if (!repoPath) throw new Error("project not registered");
        if (path !== join(root, projectId, worktree.taskId)) throw new Error("unexpected path");
        await assertNoSymlinkBelow(root, path);
        const persisted = (raw as { baseRef?: unknown }).baseRef;
        let baseRef: string;
        if (persisted !== undefined) {
          if (typeof persisted !== "string") throw new Error("baseRef must be a string");
          assertRefArg(persisted, "baseRef");
          baseRef = persisted;
        } else {
          baseRef = await this.defaultBranch(repoPath).catch(() => worktree.baseSha);
        }
        const rec: Record_ = {
          worktree,
          projectId: projectId as ProjectId,
          repoPath,
          baseRef,
        };
        if (worktree.status !== "removed") {
          let listing = listings.get(repoPath);
          if (!listing) {
            listing = await this.worktreeListing(repoPath);
            listings.set(repoPath, listing);
          }
          if (listing.get(path) !== `refs/heads/${worktree.branch}`) {
            throw new Error("not listed by git worktree list on its branch");
          }
          const owner = await this.readOwner(path);
          if (owner.taskId !== worktree.taskId) throw new Error("owner file task mismatch");
          await resolveCommit(repoPath, worktree.baseSha, "baseSha");
        }
        this.records.set(worktree.id, rec);
        restored.push({ ...worktree });
      } catch (err) {
        rejected.push({ worktree: raw, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { restored, rejected };
  }

  /** The base ref a worktree's "merged" check uses; persist it next to the record for restore. */
  baseRefOf(id: string): string | undefined {
    return this.records.get(id)?.baseRef;
  }

  get(id: string): Worktree | undefined {
    const r = this.records.get(id);
    return r ? { ...r.worktree } : undefined;
  }

  list(): Worktree[] {
    return [...this.records.values()].map((r) => ({ ...r.worktree }));
  }

  /**
   * Fail-closed removal: refuses a repo whose config defines commands, a dirty tree, or commits
   * not merged into the base ref, unless `force` (which requires an `approvalId`; the config audit
   * still applies). The branch is deleted only when fully merged.
   */
  async removeWorktree(
    id: string,
    options: RemoveWorktreeOptions = {},
  ): Promise<RemoveWorktreeResult> {
    const rec = this.active(id);
    const forced = options.force === true;
    if (forced && !options.approvalId) {
      throw new MimirError("validation_failed", "force removal requires an approvalId", { id });
    }
    const { path, branch } = rec.worktree;
    const present = (await lstat(path).catch(() => undefined)) !== undefined;
    await auditRepoConfig(rec.repoPath);
    if (present) await auditRepoConfig(path);
    const baseTip = await this.baseTip(rec);

    if (present && !forced) {
      // Never run `git status` here: it recurses into nested repos whose config is unaudited.
      await this.assertNoNestedRepos(rec);
      const { changed: dirty } = await this.snapshotWorkingTree(rec);
      if (dirty.length > 0) {
        throw new MimirError("conflict", "worktree has uncommitted changes", {
          id,
          dirty: dirty.slice(0, 50),
        });
      }
    }
    const unmerged = await this.unmergedCount(rec, baseTip, present);
    if (unmerged > 0 && !forced) {
      throw new MimirError("conflict", "worktree has commits not merged into its base", {
        id,
        baseRef: rec.baseRef,
        unmergedCommits: unmerged,
      });
    }

    if (present) {
      // Cleanliness was verified above via the filter-free snapshot (or waived by an approved
      // force). `--force` stops git from running its own recursive `status` check.
      await git(rec.repoPath, ["worktree", "remove", "--force", path]);
    } else {
      await git(rec.repoPath, ["worktree", "prune"]);
    }
    // The tree is gone: record that before anything else can fail.
    this.update(rec, { status: "removed" });

    let branchDeleted = false;
    let branchDeleteError: string | undefined;
    try {
      if (
        (await this.branchExists(rec.repoPath, branch)) &&
        !this.guard(rec.repoPath).isProtected(branch)
      ) {
        const merged = await git(
          rec.repoPath,
          ["merge-base", "--is-ancestor", `refs/heads/${branch}`, baseTip],
          { okExitCodes: [1] },
        );
        if (merged.exitCode === 0) {
          await git(rec.repoPath, ["branch", "-D", "--", branch]);
          branchDeleted = true;
        }
      }
    } catch (err) {
      branchDeleteError = err instanceof Error ? err.message : String(err);
    }

    return {
      worktree: { ...rec.worktree },
      removed: true,
      forced,
      branchDeleted,
      ...(options.approvalId ? { approvalId: options.approvalId } : {}),
      ...(branchDeleteError ? { branchDeleteError } : {}),
    };
  }

  /**
   * Changes against `baseSha`. Committed-only by default (`baseSha..HEAD`); pass
   * `includeWorkingTree` to add uncommitted and untracked work, flagged by `dirty`.
   */
  async diff(id: string, options: DiffOptions = {}): Promise<WorktreeDiff> {
    const rec = this.active(id);
    const { scratch, headSha, target, dirty } = await this.resolveDiffTarget(rec, options);
    const base = rec.worktree.baseSha;
    const [numstat, names, patch] = await Promise.all([
      scratch.run(["diff", ...DIFF_FLAGS, "--numstat", "-z", base, target, "--"]),
      scratch.run(["diff", ...DIFF_FLAGS, "--name-status", "-z", base, target, "--"]),
      scratch.run(["diff", ...DIFF_FLAGS, "--patch", base, target, "--"]),
    ]);
    const counts = new Map<string, [number, number]>();
    for (const entry of numstat.stdout.split("\0")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
      if (!m) continue;
      const n = (v: string | undefined) => (v === undefined || v === "-" ? 0 : Number(v));
      counts.set(m[3] ?? "", [n(m[1]), n(m[2])]);
    }
    const files: DiffFile[] = parseNameStatus(names.stdout).map(({ path, status }) => {
      const [additions, deletions] = counts.get(path) ?? [0, 0];
      return { path, status, additions, deletions };
    });
    return {
      baseSha: base,
      headSha,
      includesWorkingTree: options.includeWorkingTree === true,
      dirty,
      files,
      patch: patch.stdout,
    };
  }

  async changedFilesManifest(id: string, options: DiffOptions = {}): Promise<ChangedFilesManifest> {
    const rec = this.active(id);
    const { scratch, headSha, target, dirty } = await this.resolveDiffTarget(rec, options);
    const names = await scratch.run([
      "diff",
      ...DIFF_FLAGS,
      "--name-status",
      "-z",
      rec.worktree.baseSha,
      target,
      "--",
    ]);
    return {
      worktreeId: rec.worktree.id,
      baseSha: rec.worktree.baseSha,
      headSha,
      includesWorkingTree: options.includeWorkingTree === true,
      dirty,
      files: parseNameStatus(names.stdout),
    };
  }

  /** Freeze a successful task's code independently of later edits to its worktree. */
  async checkpoint(id: string): Promise<string> {
    const rec = this.active(id);
    await auditRepoConfig(rec.repoPath);
    await this.assertNoNestedRepos(rec);
    const scratch = await this.scratch(rec);
    const snap = await this.snapshotWorkingTree(rec);
    // Runtime review/log artifacts belong to the evidence store, not downstream source trees.
    const index = join(scratch.gitDir, `result-index-${randomUUID()}`);
    let tree = snap.tree;
    try {
      const env = { GIT_INDEX_FILE: index };
      await scratch.run(["read-tree", tree], { env });
      const entries = await scratch.treeEntries(tree);
      const artifacts = [...entries.keys()].filter(
        (p) => p === ".mimir" || p.startsWith(".mimir/"),
      );
      if (artifacts.length) {
        await scratch.run(["update-index", "-z", "--index-info"], {
          env,
          input: artifacts.map((p) => `0 ${"0".repeat(snap.headSha.length)}\t${p}\0`).join(""),
        });
        tree = (await scratch.run(["write-tree"], { env })).stdout.trim();
      }
    } finally {
      await rm(index, { force: true });
    }
    const sha = await this.resultCommit(
      scratch,
      tree,
      [snap.headSha],
      `Verified task ${rec.worktree.taskId}`,
    );
    await this.importResult(rec.repoPath, scratch, sha);
    await git(rec.repoPath, ["update-ref", `refs/mimir/results/${rec.worktree.taskId}`, sha]);
    return sha;
  }

  /** Combine immutable verified dependency results; conflicts stop dispatch before an agent runs. */
  async dependencyBase(
    projectId: string,
    repoPath: string,
    taskIds: readonly string[],
  ): Promise<string | undefined> {
    if (!taskIds.length) return undefined;
    const id = this.parseId(ProjectIdSchema, projectId, "projectId");
    const repo = await this.registerProject({ projectId: id, repoPath });
    await auditRepoConfig(repo);
    const scratch = await ScratchRepo.open(join(await this.ensureRoot(), SCRATCH_DIR), id, repo);
    const commits: string[] = [];
    for (const task of [...new Set(taskIds)].sort()) {
      const parsed = GitShaSchema.parse(task);
      commits.push(await resolveCommit(repo, parsed, "verified dependency commit"));
    }
    let base = commits[0]!;
    for (const next of commits.slice(1)) {
      const merge = await scratch.run(
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, next],
        { okExitCodes: [1] },
      );
      if (merge.exitCode !== 0)
        throw new MimirError(
          "conflict",
          "verified dependency results conflict; resolve before retrying",
          { taskIds },
        );
      const tree = merge.stdout.split("\n")[0]!.trim();
      base = await this.resultCommit(
        scratch,
        tree,
        [base, next],
        "Combine verified task dependencies",
      );
    }
    await this.importResult(repo, scratch, base);
    return base;
  }

  /** A binary-safe patch of immutable verified results, never the current agent worktree. */
  async exportResult(
    projectId: string,
    repoPath: string,
    bases: readonly string[],
    results: readonly string[],
  ): Promise<{ baseSha: string; resultCommit: string; patch: string }> {
    if (!bases.length || !results.length)
      throw new MimirError("conflict", "no verified result to export");
    const resultCommit = (await this.dependencyBase(projectId, repoPath, results))!;
    const id = this.parseId(ProjectIdSchema, projectId, "projectId");
    const repo = await this.registerProject({ projectId: id, repoPath });
    const scratch = await ScratchRepo.open(join(await this.ensureRoot(), SCRATCH_DIR), id, repo);
    const roots = [...new Set(bases)].map((sha) => GitShaSchema.parse(sha));
    const baseSha =
      roots.length === 1
        ? roots[0]!
        : (await scratch.run(["merge-base", "--octopus", ...roots])).stdout.trim();
    const patch = (
      await scratch.run([
        "diff",
        ...DIFF_FLAGS,
        "--binary",
        "--full-index",
        baseSha,
        resultCommit,
        "--",
      ])
    ).stdout;
    return { baseSha, resultCommit, patch };
  }

  private async resultCommit(
    scratch: ScratchRepo,
    tree: string,
    parents: string[],
    message: string,
  ): Promise<string> {
    return (
      await scratch.run(
        ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message],
        {
          env: {
            GIT_AUTHOR_NAME: "Mimir",
            GIT_AUTHOR_EMAIL: "mimir@localhost",
            GIT_COMMITTER_NAME: "Mimir",
            GIT_COMMITTER_EMAIL: "mimir@localhost",
          },
        },
      )
    ).stdout.trim();
  }

  private async importResult(repo: string, scratch: ScratchRepo, sha: string): Promise<void> {
    await git(repo, [
      "-c",
      "protocol.file.allow=always",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      scratch.gitDir,
      sha,
    ]);
  }

  /** Commits reachable from the worktree HEAD but not from `sinceSha` (default `baseSha`), oldest first. */
  async commitsSince(id: string, sinceSha?: string): Promise<CommitInfo[]> {
    const rec = this.active(id);
    const scratch = await this.scratch(rec);
    const headSha = await this.headSha(rec);
    const since = await resolveCommit(
      scratch.gitDir,
      sinceSha ?? rec.worktree.baseSha,
      "sinceSha",
      { env: { GIT_DIR: scratch.gitDir, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    const r = await scratch.run([
      "log",
      "--no-show-signature",
      "--reverse",
      "--no-color",
      "--format=%H%x00%an%x00%ae%x00%aI%x00%s%x1e",
      `${since}..${headSha}`,
      "--",
    ]);
    return r.stdout
      .split("\x1e")
      .map((s) => s.replace(/^\n/, ""))
      .filter(Boolean)
      .map((line) => {
        const [sha = "", authorName = "", authorEmail = "", authoredAt = "", subject = ""] =
          line.split("\0");
        return { sha, authorName, authorEmail, authoredAt, subject };
      });
  }

  /**
   * Dry-run merge of the worktree HEAD into `targetRef` via `git merge-tree --write-tree`, run in
   * Mimir's scratch repo (no agent merge drivers). Only committed work is considered. Nothing is
   * mutated: not the worktree, the primary clone, or this manager's record.
   */
  async detectConflicts(id: string, targetRef: string): Promise<ConflictReport> {
    const rec = this.active(id);
    const targetSha = await resolveCommit(rec.repoPath, targetRef, "targetRef");
    const headSha = await this.headSha(rec);
    const scratch = await this.scratch(rec);
    const r = await scratch.run(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", targetSha, headSha],
      { okExitCodes: [1] },
    );
    const [, ...rest] = r.stdout.split("\0");
    const conflicts = r.exitCode === 1 ? [...new Set(rest.filter(Boolean))].sort() : [];
    return { clean: r.exitCode === 0, conflicts, targetSha, headSha };
  }

  /** {@link runTests} in the managed worktree `id` (path taken from the record, not the caller). */
  async runTests(
    id: string,
    command: string[],
    options: RunTestsOptions = {},
  ): Promise<RunTestsResult> {
    const rec = this.active(id);
    return await runTests(rec.worktree.path, command, options);
  }

  /**
   * Records `sessionId` in the worktree's claim file. Fails with `conflict` when the claim file is
   * invalid, when the worktree is owned by a different task that is (or may be) live, or when it
   * is held by a different live session.
   */
  async claim(
    path: string,
    sessionId: string,
    opts: { taskId?: TaskId } = {},
  ): Promise<OwnerClaim> {
    const safe = assertSafeAbsolutePath(path, "path");
    const root = await this.resolveRootForCheck();
    if (!isInside(safe, root) || safe === root) {
      throw new MimirError("validation_failed", "path is not under the worktree root", {
        path: safe,
      });
    }
    await assertNoSymlinkBelow(root, safe);
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 200) {
      throw new MimirError("validation_failed", "sessionId is required");
    }
    let owner = await this.readOwner(safe);
    if (opts.taskId !== undefined && owner.taskId !== opts.taskId) {
      if (await this.isTaskLive(owner.taskId)) {
        throw new MimirError("conflict", "worktree is owned by another live task", {
          path: safe,
          ownerTaskId: owner.taskId,
        });
      }
      owner = { taskId: opts.taskId, createdAt: nowIso() };
    }
    if (
      owner.sessionId &&
      owner.sessionId !== sessionId &&
      (await this.isSessionLive(owner.sessionId))
    ) {
      throw new MimirError("conflict", "worktree is claimed by another live session", {
        path: safe,
        ownerSessionId: owner.sessionId,
      });
    }
    const next: OwnerClaim = { taskId: owner.taskId, sessionId, createdAt: owner.createdAt };
    const file = join(safe, OWNER_FILE);
    const tmp = join(safe, `${OWNER_FILE}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tmp, file);
    return next;
  }

  // ---- internals ----

  private parseId<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
    value: unknown,
    field: string,
  ): T {
    const r = schema.safeParse(value);
    if (!r.success) {
      throw new MimirError("validation_failed", `${field} is not a valid id`, { field, value });
    }
    return r.data;
  }

  private active(id: string): Record_ {
    const rec = this.records.get(id);
    if (!rec) throw new MimirError("not_found", "unknown worktree", { id });
    if (rec.worktree.status === "removed") {
      throw new MimirError("invalid_transition", "worktree already removed", { id });
    }
    return rec;
  }

  private update(rec: Record_, patch: Partial<Pick<Worktree, "status">>): void {
    rec.worktree = {
      ...rec.worktree,
      ...patch,
      updatedAt: nowIso(),
      version: rec.worktree.version + 1,
    };
  }

  private async isTaskLive(taskId: string): Promise<boolean> {
    if (this.isTaskLiveOpt) return await this.isTaskLiveOpt(taskId);
    const known = [...this.records.values()].filter((r) => r.worktree.taskId === taskId);
    // Unknown task (e.g. after a restart without restore): assume live, never take over.
    if (known.length === 0) return true;
    return known.some((r) => r.worktree.status !== "removed");
  }

  /** Reads and validates the owner claim file; anything unexpected is a `conflict`. */
  private async readOwner(path: string): Promise<OwnerClaim> {
    const file = join(path, OWNER_FILE);
    const st = await lstat(file).catch(() => undefined);
    if (!st) throw new MimirError("not_found", "no ownership claim at path", { path });
    if (!st.isFile() || st.size > 64 * 1024) {
      throw new MimirError("conflict", "ownership claim is not a small regular file", { path });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      throw new MimirError("conflict", "ownership claim is unreadable", { path }, { cause: err });
    }
    const r = OwnerClaimSchema.safeParse(parsed);
    if (!r.success) {
      throw new MimirError("conflict", "ownership claim is invalid", {
        path,
        issues: r.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const { taskId, sessionId, createdAt } = r.data;
    return sessionId === undefined ? { taskId, createdAt } : { taskId, sessionId, createdAt };
  }

  private scratch(rec: Record_): Promise<ScratchRepo> {
    let p = this.scratches.get(rec.projectId);
    if (!p) {
      p = this.ensureRoot().then((root) =>
        ScratchRepo.open(join(root, SCRATCH_DIR), rec.projectId, rec.repoPath),
      );
      p.catch(() => this.scratches.delete(rec.projectId));
      this.scratches.set(rec.projectId, p);
    }
    return p;
  }

  private async headSha(rec: Record_): Promise<string> {
    return await resolveCommit(rec.worktree.path, "HEAD", "HEAD");
  }

  private async resolveDiffTarget(
    rec: Record_,
    options: DiffOptions,
  ): Promise<{ scratch: ScratchRepo; headSha: string; target: string; dirty: boolean }> {
    const scratch = await this.scratch(rec);
    const headSha = await this.headSha(rec);
    if (!options.includeWorkingTree) return { scratch, headSha, target: headSha, dirty: false };
    await this.assertNoNestedRepos(rec);
    const snap = await this.snapshotWorkingTree(rec);
    return { scratch, headSha: snap.headSha, target: snap.tree, dirty: snap.changed.length > 0 };
  }

  /**
   * Filter-free snapshot of the worktree: tracked paths from the index and HEAD plus untracked,
   * non-ignored files (`ls-files` reads the index and walks directories; it runs no filters and
   * does not descend into nested repositories).
   */
  private async snapshotWorkingTree(
    rec: Record_,
  ): Promise<{ headSha: string; tree: string; changed: string[] }> {
    const scratch = await this.scratch(rec);
    const headSha = await this.headSha(rec);
    const { path } = rec.worktree;
    const listed = await git(path, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    // ls-files only reports a directory entry ("dir/") for something it will not descend into:
    // a nested repository. Fail closed whatever the filesystem walk found.
    const dirEntries = listed.stdout
      .split("\0")
      .filter((p) => p.endsWith("/"))
      .map((p) => p.slice(0, -1));
    if (dirEntries.length > 0) {
      throw new MimirError(
        "policy_denied",
        "worktree contains nested repositories or submodules; refusing to read through them",
        { id: rec.worktree.id, paths: dirEntries.sort() },
      );
    }
    const head = await scratch.treeEntries(headSha);
    const paths = new Set([...listed.stdout.split("\0").filter(Boolean), ...head.keys()]);
    const snap = await scratch.snapshot(path, headSha, [...paths].sort(), new Set([OWNER_FILE]));
    const changed = new Set([...snap.changed, ...(await this.indexChanges(path, head))]);
    return { headSha, tree: snap.tree, changed: [...changed].sort() };
  }

  /**
   * Paths where the index differs from HEAD: different (mode, sha), index-only, missing from the
   * index, or unmerged (stage != 0). `ls-files -s` reads the index only and runs no filters.
   */
  private async indexChanges(
    path: string,
    head: Map<string, { mode: string; sha: string }>,
  ): Promise<string[]> {
    const r = await git(path, ["ls-files", "-s", "-z"]);
    const changed = new Set<string>();
    const seen = new Set<string>();
    for (const entry of r.stdout.split("\0")) {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(entry);
      if (!m) continue;
      const [, mode, sha, stage, p = ""] = m;
      if (p === OWNER_FILE) continue;
      seen.add(p);
      const prev = head.get(p);
      if (stage !== "0" || !prev || prev.mode !== mode || prev.sha !== sha) changed.add(p);
    }
    for (const p of head.keys()) if (!seen.has(p)) changed.add(p);
    return [...changed];
  }

  /**
   * Fails closed (`policy_denied`, naming the paths) when the worktree holds gitlinks (index or
   * HEAD, mode 160000) or any nested `.git` directory/file. Their configs are agent-controlled and
   * never audited, so no operation may read through them.
   */
  private async assertNoNestedRepos(rec: Record_): Promise<void> {
    const { path } = rec.worktree;
    const found = new Set<string>();
    const index = await git(path, ["ls-files", "-s", "-z"]);
    for (const entry of index.stdout.split("\0")) {
      const m = /^160000 [0-9a-f]+ \d+\t(.*)$/s.exec(entry);
      if (m?.[1]) found.add(m[1]);
    }
    const scratch = await this.scratch(rec);
    for (const [p, e] of await scratch.treeEntries(await this.headSha(rec))) {
      if (e.mode === "160000") found.add(p);
    }
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        // Case-insensitive: on macOS/Windows `.GIT` is still a repository to git.
        if (ent.name.toLowerCase() === ".git") {
          if (rel) found.add(rel);
          continue;
        }
        // Dirent.isDirectory() is false for symlinks, so links are never followed.
        if (ent.isDirectory()) {
          await walk(join(dir, ent.name), rel ? `${rel}/${ent.name}` : ent.name);
        }
      }
    };
    await walk(path, "");
    if (found.size > 0) {
      throw new MimirError(
        "policy_denied",
        "worktree contains nested repositories or submodules; refusing to read through them",
        { id: rec.worktree.id, paths: [...found].sort() },
      );
    }
  }

  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    const r = await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      okExitCodes: [1],
    });
    return r.exitCode === 0;
  }

  private async worktreeListing(repoPath: string): Promise<Map<string, string>> {
    const r = await git(repoPath, ["worktree", "list", "--porcelain", "-z"]);
    const map = new Map<string, string>();
    let current: string | undefined;
    for (const line of r.stdout.split("\0")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      else if (line.startsWith("branch ") && current) map.set(current, line.slice(7));
      else if (line === "") current = undefined;
    }
    return map;
  }

  /** Real path of the root, resolving the nearest existing ancestor when it does not exist yet. */
  private async resolveRootForCheck(): Promise<string> {
    if (this.realRoot) return this.realRoot;
    return await realpathLoose(this.worktreeRoot);
  }

  private async ensureRoot(): Promise<string> {
    if (this.realRoot) return this.realRoot;
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o700 });
    const real = await realpath(this.worktreeRoot);
    const realData = await Promise.all(this.dataDirs.filter(isAbsolute).map(realpathLoose));
    assertOutsideDataDirs(real, realData);
    for (const repo of this.projects.values()) {
      if (isInside(real, repo)) {
        throw new MimirError(
          "validation_failed",
          "worktree root must not be inside a project clone",
          { repoPath: repo, worktreeRoot: real },
        );
      }
    }
    this.realRoot = real;
    return real;
  }

  private async defaultBranch(repoPath: string): Promise<string> {
    const remote = await git(
      repoPath,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { okExitCodes: [1, 128] },
    );
    if (remote.exitCode === 0 && remote.stdout.trim()) return remote.stdout.trim();
    const local = await git(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      okExitCodes: [1, 128],
    });
    if (local.exitCode === 0 && local.stdout.trim()) return local.stdout.trim();
    throw new MimirError("validation_failed", "cannot determine the default branch; pass baseRef", {
      repoPath,
    });
  }

  private async ensureOwnerFileIgnored(repoPath: string): Promise<void> {
    const r = await git(repoPath, ["rev-parse", "--git-common-dir"]);
    const raw = r.stdout.trim();
    const commonDir = isAbsolute(raw) ? raw : resolve(repoPath, raw);
    const infoDir = join(commonDir, "info");
    const exclude = join(infoDir, "exclude");
    const line = `/${OWNER_FILE}`;
    const current = await readFile(exclude, "utf8").catch(() => "");
    if (current.split(/\r?\n/).includes(line)) return;
    await mkdir(infoDir, { recursive: true });
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(exclude, `${sep}${line}\n`);
  }

  /** Commit that work must be reachable from to count as merged: the live base ref, else baseSha. */
  private async baseTip(rec: Record_): Promise<string> {
    try {
      return await resolveCommit(rec.repoPath, rec.baseRef, "baseRef");
    } catch {
      return rec.worktree.baseSha;
    }
  }

  private async unmergedCount(rec: Record_, target: string, present: boolean): Promise<number> {
    const tips: string[] = [];
    const b = await git(
      rec.repoPath,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${rec.worktree.branch}`],
      { okExitCodes: [1, 128] },
    );
    if (b.exitCode === 0) tips.push(b.stdout.trim());
    if (present) tips.push(await this.headSha(rec));
    if (tips.length === 0) return 0;
    const r = await git(rec.repoPath, ["rev-list", "--count", ...tips, "--not", target, "--"]);
    return Number(r.stdout.trim()) || 0;
  }
}

async function realpathLoose(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await realpathLoose(parent), basename(p));
  }
}

function parseNameStatus(out: string): { path: string; status: FileChangeStatus }[] {
  const parts = out.split("\0");
  const files: { path: string; status: FileChangeStatus }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (!code || path === undefined) continue;
    files.push({ path, status: STATUS_CODES[code[0] ?? ""] ?? "unknown" });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
