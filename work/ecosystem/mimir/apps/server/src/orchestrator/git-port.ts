import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  branchNameFor,
  type ChangedFilesManifest,
  type CreateWorktreeInput,
  type GitManager,
  type RestoreRecord,
  type WorktreeDiff,
} from "@mimir/git";
import type { ProjectId, Worktree } from "@mimir/protocol";

/** A worktree as persisted by Mimir (`git.worktree_created` + the task's project). */
export interface PersistedWorktree {
  worktree: Worktree;
  projectId: string;
  repoPath: string;
  /** Persisted base ref; without it `GitManager.restore` uses the project's default branch. */
  baseRef?: string;
}

/** Outcome of {@link WorktreePort.restore}: how many were re-adopted, and why the rest were not. */
export interface WorktreeRestoreResult {
  restored: number;
  rejected: { worktreeId: string | undefined; reason: string }[];
}

/** The slice of `@mimir/git` the orchestrator uses. */
export interface WorktreePort {
  create(input: CreateWorktreeInput): Promise<Worktree>;
  /** Whether the manager currently knows this worktree (in-memory registry). */
  has(id: string): boolean;
  /** Where `create` will put a task's worktree, and its branch (for classifying before it exists). */
  plan(input: Omit<CreateWorktreeInput, "repoPath" | "baseRef">): { path: string; branch: string };
  /** The base ref a worktree was created from (persisted for `restore`). */
  baseRefOf(id: string): string | undefined;
  checkpoint(id: string): Promise<string>;
  exportResult(
    projectId: string,
    repoPath: string,
    bases: readonly string[],
    results: readonly string[],
  ): Promise<{ baseSha: string; resultCommit: string; patch: string }>;
  dependencyBase(
    projectId: string,
    repoPath: string,
    taskIds: readonly string[],
  ): Promise<string | undefined>;
  diff(id: string): Promise<WorktreeDiff>;
  changedFilesManifest(id: string): Promise<ChangedFilesManifest>;
  /**
   * Re-adopts persisted worktrees after a restart. Records the manager refuses (missing on disk,
   * wrong branch, bad owner file, unregistrable project) are returned as rejected, never thrown.
   */
  restore(records: readonly PersistedWorktree[]): Promise<WorktreeRestoreResult>;
}

/** `WorktreePort` over `GitManager`. */
export class GitWorktreePort implements WorktreePort {
  constructor(readonly manager: GitManager) {}

  create(input: CreateWorktreeInput): Promise<Worktree> {
    return this.manager.createWorktree(input);
  }

  checkpoint(id: string): Promise<string> {
    return this.manager.checkpoint(id);
  }

  exportResult(
    projectId: string,
    repoPath: string,
    bases: readonly string[],
    results: readonly string[],
  ) {
    return this.manager.exportResult(projectId, repoPath, bases, results);
  }

  dependencyBase(
    projectId: string,
    repoPath: string,
    taskIds: readonly string[],
  ): Promise<string | undefined> {
    return this.manager.dependencyBase(projectId, repoPath, taskIds);
  }

  has(id: string): boolean {
    return this.manager.get(id) !== undefined;
  }

  plan(input: Omit<CreateWorktreeInput, "repoPath" | "baseRef">): { path: string; branch: string } {
    let root = this.manager.worktreeRoot;
    try {
      root = realpathSync(root);
    } catch {
      // not created yet: GitManager creates it under the same (already resolved) path
    }
    return {
      path: join(root, input.projectId, input.taskId),
      branch: branchNameFor(input.crewSlug, input.taskId, input.taskSlug),
    };
  }

  baseRefOf(id: string): string | undefined {
    return this.manager.baseRefOf(id);
  }

  diff(id: string): Promise<WorktreeDiff> {
    // Agents may finish without committing; verification evidence must include their edits.
    return this.manager.diff(id, { includeWorkingTree: true });
  }

  changedFilesManifest(id: string): Promise<ChangedFilesManifest> {
    return this.manager.changedFilesManifest(id);
  }

  async restore(records: readonly PersistedWorktree[]): Promise<WorktreeRestoreResult> {
    const rejected: WorktreeRestoreResult["rejected"] = [];
    if (records.length === 0) return { restored: 0, rejected };
    // `GitManager.restore` only accepts worktrees of projects it knows: register each project
    // first. A project that cannot be registered rejects its own records, not the whole batch.
    const unregistrable = new Map<string, string>();
    for (const r of records) {
      if (unregistrable.has(r.projectId)) continue;
      try {
        await this.manager.registerProject({
          projectId: r.projectId as ProjectId,
          repoPath: r.repoPath,
        });
      } catch (err) {
        unregistrable.set(r.projectId, err instanceof Error ? err.message : String(err));
      }
    }
    const accepted: RestoreRecord[] = [];
    for (const r of records) {
      const reason = unregistrable.get(r.projectId);
      if (reason !== undefined) {
        rejected.push({ worktreeId: r.worktree.id, reason: `project not registrable: ${reason}` });
        continue;
      }
      accepted.push(r.baseRef !== undefined ? { ...r.worktree, baseRef: r.baseRef } : r.worktree);
    }
    const result = await this.manager.restore(accepted);
    for (const { worktree, reason } of result.rejected) {
      const id = (worktree as { id?: unknown } | null)?.id;
      rejected.push({ worktreeId: typeof id === "string" ? id : undefined, reason });
    }
    return { restored: result.restored.length, rejected };
  }
}
