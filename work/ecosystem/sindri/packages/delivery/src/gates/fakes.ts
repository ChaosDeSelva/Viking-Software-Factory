import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrokkrCheckResult, VerificationReport } from "./brokkr-report.js";
import { sha256Of } from "./evidence.js";
import type {
  ArtifactContentReader,
  CreateCrewInput,
  CreateTaskInput,
  ExecutionEventView,
  ExecutionReader,
  ExecutionTaskView,
  ExecutionView,
  MimirActions,
  MimirArtifactView,
  MimirMissionView,
  PlanTaskView,
  PlanView,
  PrRequestInput,
  PrRequestResult,
} from "./ports.js";

/** A scripted execution plus a scripted Mimir, implementing every S6 port in memory (tests). */
export class FakeDeliveryWorld implements ExecutionReader, MimirActions, ArtifactContentReader {
  readonly executionId: string;
  readonly missionId: string;
  plan: PlanView;
  status = "verified_pending_review";
  readonly execTasks: ExecutionTaskView[] = [];
  readonly eventLog: ExecutionEventView[] = [];
  readonly artifacts = new Map<string, MimirArtifactView>();
  readonly contents = new Map<string, string>();
  readonly crews: { id: string; template: string }[] = [];
  readonly missionTasks: MimirMissionView["tasks"] = [];
  missionStatus = "active";
  readonly calls: { method: string; args: unknown[]; key?: string }[] = [];
  /** Methods that throw on their next call. */
  readonly failures = new Map<string, Error>();
  #seq = 0;
  #manifestInStep = new Set<string>();
  #stepOpen = new Set<string>();

  constructor(plan: PlanView, ids: { executionId?: string; missionId?: string } = {}) {
    this.plan = plan;
    this.executionId = ids.executionId ?? "exe_1";
    this.missionId = ids.missionId ?? "mis_1";
  }

  /** Adds a task to Sindri's records and to Mimir's mission, in `crewId`. */
  addTask(
    planTaskId: string,
    mimirTaskId: string,
    crewId: string,
    init: { status?: string; attempts?: number; template?: string } = {},
  ): this {
    this.execTasks.push({
      planTaskId,
      mimirTaskId,
      mimirSessionId: null,
      status: init.status ?? "completed",
      attempts: init.attempts ?? 0,
    });
    if (!this.crews.some((c) => c.id === crewId)) {
      this.crews.push({ id: crewId, template: init.template ?? "implementer" });
    }
    this.missionTasks.push({
      id: mimirTaskId,
      crewId,
      status: init.status ?? "completed",
      title: `${planTaskId}: task`,
    });
    return this;
  }

  event(
    type: string,
    payload: unknown,
    refs: {
      taskId?: string | null;
      sessionId?: string | null;
      source?: string | null;
      provenance?: string | null;
    } = {},
  ): string {
    const id = `evt_${String(++this.#seq).padStart(4, "0")}`;
    this.eventLog.push({
      mimirEventId: id,
      type,
      payload,
      occurredAt: new Date(Date.UTC(2026, 9, 14, 10, 0, this.#seq)).toISOString(),
      mimirTaskId: refs.taskId === undefined ? null : refs.taskId,
      sessionId: refs.sessionId ?? null,
      source: refs.source === undefined ? "mimir.server" : refs.source,
      provenance: refs.provenance === undefined ? "observed" : refs.provenance,
    });
    return id;
  }

  /** Records an artifact (content + `artifact.recorded` event). Returns the artifact id. */
  artifact(
    mimirTaskId: string,
    kind: string,
    content: string,
    opts: {
      uri?: string;
      hash?: string;
      /** Envelope task id when it differs from the payload's (forgery tests). */
      envelopeTaskId?: string | null;
      source?: string | null;
      provenance?: string | null;
      /**
       * Brokkr reports only: the `headSha` of the `changed-files` manifest Mimir's server records
       * first in the same verifying step (default `HEAD_SHA`; `null` records no manifest).
       */
      manifestHead?: string | null;
    } = {},
  ): string {
    // Mimir's verifying step: `task.verifying`, then the diff and `changed-files` manifest (with
    // the worktree `headSha`), then the Brokkr report. It never emits `git.commit_observed`.
    const verifyingKinds = ["brokkr.verification-report", "changed-files", "diff"];
    if (verifyingKinds.includes(kind) && !this.#stepOpen.has(mimirTaskId)) {
      this.event("task.verifying", { from: "running", to: "verifying" }, { taskId: mimirTaskId });
      this.#stepOpen.add(mimirTaskId);
    }
    if (kind === "brokkr.verification-report") {
      const head = opts.manifestHead === undefined ? HEAD_SHA : opts.manifestHead;
      if (head !== null && !this.#manifestInStep.has(mimirTaskId)) {
        this.artifact(mimirTaskId, "changed-files", changedFilesManifest(head));
      }
      this.#manifestInStep.delete(mimirTaskId);
      this.#stepOpen.delete(mimirTaskId);
    } else if (kind === "changed-files") {
      this.#manifestInStep.add(mimirTaskId);
    }
    const id = `art_${String(++this.#seq).padStart(4, "0")}`;
    const artifact: MimirArtifactView = {
      id,
      taskId: mimirTaskId,
      kind,
      uri: opts.uri ?? `file:///artifacts/${mimirTaskId}/${kind}`,
      hash: opts.hash ?? `sha256:${sha256Of(content)}`,
    };
    this.artifacts.set(id, artifact);
    this.contents.set(id, content);
    this.event(
      "artifact.recorded",
      { artifactId: id, taskId: mimirTaskId, kind, uri: artifact.uri, hash: artifact.hash },
      {
        taskId: opts.envelopeTaskId === undefined ? mimirTaskId : opts.envelopeTaskId,
        // Mimir (T12) records artifacts with provenance `derived`.
        provenance: opts.provenance === undefined ? "derived" : opts.provenance,
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      },
    );
    return id;
  }

  // ExecutionReader -----------------------------------------------------------------------------

  execution(executionId: string): Promise<ExecutionView | undefined> {
    if (executionId !== this.executionId) return Promise.resolve(undefined);
    return Promise.resolve({
      id: this.executionId,
      planId: this.plan.id,
      planVersion: this.plan.version,
      mimirMissionId: this.missionId,
      status: this.status,
      plan: this.plan,
    });
  }

  tasks(executionId: string): Promise<ExecutionTaskView[]> {
    return Promise.resolve(executionId === this.executionId ? [...this.execTasks] : []);
  }

  events(executionId: string): Promise<ExecutionEventView[]> {
    return Promise.resolve(executionId === this.executionId ? [...this.eventLog] : []);
  }

  claimAttempt(executionId: string, planTaskId: string): Promise<number> {
    const t = this.execTasks.find((x) => x.planTaskId === planTaskId);
    if (executionId !== this.executionId || !t) {
      return Promise.reject(new Error(`unknown task ${planTaskId}`));
    }
    t.attempts += 1;
    return Promise.resolve(t.attempts);
  }

  // MimirActions --------------------------------------------------------------------------------

  #call(method: string, args: unknown[], key?: string) {
    this.calls.push({ method, args, ...(key ? { key } : {}) });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  getArtifact(artifactId: string): Promise<MimirArtifactView> {
    return Promise.resolve().then(() => {
      this.#call("getArtifact", [artifactId]);
      const a = this.artifacts.get(artifactId);
      if (!a) throw new Error(`artifact ${artifactId} not found`);
      return a;
    });
  }

  getMission(missionId: string): Promise<MimirMissionView> {
    return Promise.resolve().then(() => {
      this.#call("getMission", [missionId]);
      return {
        status: this.missionStatus,
        crews: [...this.crews],
        tasks: [...this.missionTasks],
      };
    });
  }

  sendInstruction(sessionId: string, text: string, key: string): Promise<void> {
    return Promise.resolve().then(() => this.#call("sendInstruction", [sessionId, text], key));
  }

  retry(mimirTaskId: string, attempt: number, reason: string): Promise<void> {
    return Promise.resolve().then(() =>
      this.#call("retry", [mimirTaskId, reason], `sindri:retry:${mimirTaskId}:${attempt}`),
    );
  }

  createCrew(input: CreateCrewInput, key: string): Promise<{ crewId: string }> {
    return Promise.resolve().then(() => {
      this.#call("createCrew", [input], key);
      const crewId = `crw_${input.role}_${randomUUID().slice(0, 8)}`;
      this.crews.push({ id: crewId, template: input.role });
      return { crewId };
    });
  }

  createTask(input: CreateTaskInput, key: string): Promise<{ taskId: string }> {
    return Promise.resolve().then(() => {
      this.#call("createTask", [input], key);
      const taskId = `mt_${String(++this.#seq).padStart(4, "0")}`;
      this.missionTasks.push({
        id: taskId,
        crewId: input.crewId,
        status: "ready",
        title: input.title,
      });
      return { taskId };
    });
  }

  requestPr(mimirTaskId: string, input: PrRequestInput, key: string): Promise<PrRequestResult> {
    return Promise.resolve().then(() => {
      this.#call("requestPr", [mimirTaskId, input], key);
      return { status: "requested" as const };
    });
  }

  /** Marks a Mimir task's status (e.g. the reviewer finished). */
  setMissionTaskStatus(taskId: string, status: string): void {
    const t = this.missionTasks.find((x) => x.id === taskId);
    if (t) t.status = status;
  }

  // ArtifactContentReader -----------------------------------------------------------------------

  read(artifact: MimirArtifactView): Promise<string> {
    const text = this.contents.get(artifact.id);
    return text === undefined
      ? Promise.reject(new Error(`no content for ${artifact.id}`))
      : Promise.resolve(text);
  }
}

/** The commit the scripted implementer task ends on (and Brokkr verified). */
export const HEAD_SHA = "abc1234def5678abc1234def5678abc1234def56";
/** The worktree base the scripted task started from. */
export const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

/** The `changed-files` manifest Mimir records (`ChangedFilesManifest` in `@mimir/git`). */
export function changedFilesManifest(
  headSha: string,
  files: { path: string; status: string }[] = [],
  baseSha = BASE_SHA,
): string {
  return JSON.stringify({
    worktreeId: "wt_1",
    baseSha,
    headSha,
    includesWorkingTree: false,
    dirty: false,
    files,
  });
}

export const LOCK_DIGEST = `sha256:${"a".repeat(64)}`;

export function planTaskView(id: string, overrides: Partial<PlanTaskView> = {}): PlanTaskView {
  return {
    id,
    objective: `Do ${id}`,
    acceptanceCriteria: ["AC-1"],
    dependsOn: [],
    harnessId: "backend-node",
    harnessVersion: "1.0.0",
    harnessLockDigest: LOCK_DIGEST,
    role: "implementer",
    maxRetries: 2,
    ...overrides,
  };
}

export function planView(tasks: PlanTaskView[], overrides: Partial<PlanView> = {}): PlanView {
  return {
    id: "pln_1",
    projectId: "prj_1",
    lineageId: "lin_1",
    specId: "spc_1",
    specVersion: 1,
    version: 1,
    tasks,
    ...overrides,
  };
}

/** A check result in Brokkr's shape. */
export function brokkrCheck(
  id: string,
  state: BrokkrCheckResult["state"] = "passed",
  extra: Partial<BrokkrCheckResult> = {},
): BrokkrCheckResult {
  return {
    id,
    required: true,
    state,
    command: id === "unit" ? ["pnpm", "test"] : ["tsc", "--noEmit"],
    cwd: ".",
    from: ["backend-node@1.0.0"],
    durationMs: 10,
    exitCode: state === "passed" ? 0 : state === "failed" ? 1 : null,
    ...extra,
  };
}

/**
 * A passing report for `mt_impl` in Brokkr's own shape: the real `fixtures/brokkr-report.passed.json`
 * with the task, lock and checks adjusted.
 */
export function brokkrReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  const base = JSON.parse(
    readFileSync(new URL("./fixtures/brokkr-report.passed.json", import.meta.url), "utf8"),
  ) as VerificationReport;
  return {
    ...base,
    id: "run_1",
    taskId: "mt_impl",
    harness: { name: "backend-node", version: "1.0.0", lockDigest: LOCK_DIGEST },
    repository: { commitSha: HEAD_SHA },
    checks: [
      brokkrCheck("typecheck"),
      brokkrCheck("unit"),
      brokkrCheck("build", "skipped", { required: false }),
    ],
    exceptions: [],
    summary: { passed: 2, failed: 0, skipped: 1, errored: 0 },
    ...overrides,
  };
}
