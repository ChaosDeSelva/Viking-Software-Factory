/**
 * How an orchestrator (Mimir) uses Brokkr, without importing anything from it
 * except `@brokkr/sdk`:
 *
 * 1. Receive the mission's Selection from the planner (or resolve it once when
 *    the mission is accepted) and store it: its lock is the verification
 *    contract. The worktree the agents write is never trusted to define it.
 * 2. After the crew finishes, call `verify` on the exact worktree with the
 *    stored lock pinned, approvals from the orchestrator's own store, and an
 *    injected `CheckExecutor` that owns where and how commands run.
 * 3. Consume the streaming `verification.*` events into the orchestrator's own
 *    log (it stays the source of truth for mission history; ordering is per
 *    stream, by `sequence`).
 * 4. Decide what happens next from Brokkr's verdict. Repair, retry or approval
 *    is the orchestrator's decision; Brokkr's verdict itself is never changed.
 */
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import {
  Brokkr,
  LocalProcessExecutor,
  type ApprovedException,
  type HarnessLock,
  type Selection,
  type CheckExecutionRequest,
  type CheckExecutionResult,
  type CheckExecutor,
  type TaskDescriptor,
  type VerificationEvent,
  type VerificationReport,
} from "@brokkr/sdk";

/**
 * Runs checks only inside one worktree. A real orchestrator would start them
 * in its sandbox or a container here; this example delegates to Brokkr's local
 * executor after enforcing the worktree boundary and keeping an audit trail.
 */
export class WorktreeExecutor implements CheckExecutor {
  readonly executed: Array<{ checkId: string; workspace: string }> = [];
  private readonly inner = new LocalProcessExecutor();

  constructor(private readonly worktree: string) {}

  async execute(
    request: CheckExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CheckExecutionResult> {
    const root = await realpath(this.worktree);
    const target = await realpath(request.workspace).catch(() => request.workspace);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      const now = new Date().toISOString();
      return {
        checkId: request.checkId,
        state: "errored",
        reason: "cwd_rejected",
        error: `workspace ${request.workspace} is outside worktree ${root}`,
        exitCode: null,
        signal: null,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        outputTail: "",
        outputBytes: 0,
        truncated: false,
        secretFindings: 0,
      };
    }
    this.executed.push({ checkId: request.checkId, workspace: request.workspace });
    return this.inner.execute(request, signal);
  }
}

export type MissionState = "verified" | "needs_repair" | "needs_human" | "cancelled";

export interface MissionVerification {
  state: MissionState;
  report: VerificationReport;
  /** The orchestrator's own copy of the event stream. */
  log: VerificationEvent[];
  executed: Array<{ checkId: string; workspace: string }>;
  /** Short diagnostics for a repair task: failing required checks and Brokkr's reasons. */
  diagnosis: string[];
}

/** Mission accepted: resolve the verification contract once, outside any worktree. */
export async function planMission(
  repo: string,
  task: TaskDescriptor,
  homeDir?: string,
): Promise<Selection> {
  // Default trust is "workspace-untrusted": the repository's .brokkr/ is not read, and
  // no user harness may shadow a built-in. Store the returned selection's lock in the
  // orchestrator's own mission record: that record, not the selection, is the pin.
  const brokkr = new Brokkr({ cwd: repo, offline: true, ...(homeDir ? { homeDir } : {}) });
  return brokkr.resolve({ task });
}

export async function verifyMission(input: {
  /** Repository root (used for repository signals only; its .brokkr/ is not read). */
  repo: string;
  /** The crew's worktree: the exact tree that is verified. */
  worktree: string;
  missionId: string;
  /** The Selection to verify (it may have travelled through untrusted hands). */
  selection: Selection;
  /** The lock recorded in the orchestrator's own store when the mission was accepted. */
  pinnedLock: HarnessLock;
  /** Brokkr home (user harnesses, org policy); defaults to the OS user's home. */
  homeDir?: string;
  /** Approvals recorded in the orchestrator's own approval store, if any. */
  approvals?: ApprovedException[];
  signal?: AbortSignal;
}): Promise<MissionVerification> {
  const executor = new WorktreeExecutor(input.worktree);
  const brokkr = new Brokkr({
    cwd: input.repo,
    offline: true,
    executor,
    lock: input.pinnedLock, // from the orchestrator's record, never from the selection
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    exceptions: input.approvals ?? [],
  });

  const log: VerificationEvent[] = [];
  const report = await brokkr.verify({
    selection: input.selection,
    workspace: input.worktree,
    correlationId: `${input.missionId}/verify-1`,
    workspaceId: input.worktree.split("/").pop() ?? input.missionId,
    ...(input.signal ? { signal: input.signal } : {}),
    onEvent: (event) => log.push(event),
  });

  const diagnosis = report.checks
    .filter((c) => c.required && c.state !== "passed")
    .map((c) => `${c.id}: ${c.state}${c.exitCode != null ? ` (exit ${c.exitCode})` : ""}`);
  const state: MissionState =
    report.verdict === "passed"
      ? "verified"
      : report.interrupted
        ? "cancelled"
        : report.verdict === "failed"
          ? "needs_repair"
          : "needs_human"; // incomplete or blocked: a person must look
  return { state, report, log, executed: executor.executed, diagnosis };
}
