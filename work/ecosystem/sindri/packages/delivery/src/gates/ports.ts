/**
 * The narrow views S6 needs of S5's execution records and of Mimir. Gates, reviews, reports,
 * knowledge updates and tracing depend only on these, so they run against in-memory fakes in
 * tests and against `DeliveryLoop` + `MimirClientFacade` in production (see `binding.ts`).
 */

/** The parts of an approved `@sindri/planner` plan task that quality and delivery read. */
export interface PlanTaskView {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  harnessId: string;
  harnessVersion: string;
  harnessLockDigest: string;
  role: string;
  maxRetries: number;
  /** Lessons the planner gave the task (`fg:<id>`); a research document may cite these. */
  lessonContext?: { id: string; title: string; text: string }[];
}

/** Where a research task may look (see `@sindri/planner` `ResearchPlan`). */
export interface ResearchSourcesView {
  code: boolean;
  feedbackGraph: boolean;
  web: boolean;
}

/** `@sindri/planner` `PlanWork`; absent on plans from before work kinds (code changes). */
export interface PlanWorkView {
  kind: "change" | "research" | "pr_review";
  research?: { sources: ResearchSourcesView; factCheck: boolean; question?: string };
  prReview?: PrReviewView;
}

/** `@sindri/planner` `PrReviewPlan`: the pull request a PR review reviews. */
export interface PrReviewView {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string | null;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  isCrossRepository: boolean;
  files: string[];
  filesOmitted: number;
  nonce: string;
}

/** The pull request's diff, read from Sindri's review mirror (never the operator's checkout). */
export interface PrDiffReader {
  /**
   * `git diff --unified=0 <base>...<head>` in the mirror: the change against the merge base, as
   * GitHub shows a pull request, so LEFT-side lines are lines of the merge base.
   */
  diff(projectId: string, pr: PrReviewView): Promise<{ diff: string; mergeBaseSha: string }>;
}

/** `@sindri/knowledge` `GuidanceSnapshot`, as stored in the plan. */
export interface GuidanceView {
  skills: { id: string; name: string; digest: string; content: string }[];
  omitted: { id: string; name: string; digest: string }[];
  projectNotes: string;
  requestNotes: string;
  projectNotesDigest: string | null;
  requestNotesDigest: string | null;
}

export interface PlanView {
  id: string;
  projectId: string;
  lineageId?: string;
  specId: string;
  specVersion: number;
  version: number;
  tasks: PlanTaskView[];
  work?: PlanWorkView;
  guidance?: GuidanceView;
}

export interface ExecutionView {
  id: string;
  planId: string;
  planVersion: number;
  mimirMissionId: string;
  status: string;
  /** The plan exactly as executed. */
  plan: PlanView;
}

export interface ExecutionTaskView {
  planTaskId: string;
  mimirTaskId: string;
  /** Latest Mimir session seen on the task; `null` until one ran. */
  mimirSessionId: string | null;
  /** Mimir task status, from `task.*` events only. */
  status: string;
  attempts: number;
}

/** One Mimir event as recorded for an execution. */
export interface ExecutionEventView {
  mimirEventId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
  /** Envelope `taskId`. `null` when unknown: such events never satisfy a task's gate. */
  mimirTaskId: string | null;
  /** Envelope `sessionId`, when known. */
  sessionId: string | null;
  /** Envelope `source` (e.g. `mimir.server`); `null` when unknown, which is never trusted. */
  source: string | null;
  /** Envelope `provenance`: `observed`, `derived` or `summarized`; `null` when unknown. */
  provenance: string | null;
}

export interface ExecutionReader {
  execution(executionId: string): Promise<ExecutionView | undefined>;
  tasks(executionId: string): Promise<ExecutionTaskView[]>;
  /** In the order Sindri recorded them (per stream; no global order is implied). */
  events(executionId: string): Promise<ExecutionEventView[]>;
  /**
   * Increments the task's shared `execution_tasks.attempts` (the counter DeliveryLoop also uses)
   * and returns the new value. Callers act only while it stays within the plan's `maxRetries`.
   */
  claimAttempt(executionId: string, planTaskId: string): Promise<number>;
}

export interface MimirArtifactView {
  id: string;
  taskId: string;
  kind: string;
  uri: string;
  /** `sha256:<hex>` (or bare hex). */
  hash: string;
}

export interface MimirMissionView {
  /** Mission status (`draft`, `active`, `paused`, `completed`, `cancelled`, ...). */
  status: string;
  crews: { id: string; template: string }[];
  tasks: { id: string; crewId: string | null; status: string; title: string }[];
}

export interface CreateCrewInput {
  missionId: string;
  role: "reviewer" | "qa";
  agentKind: string;
}

export interface CreateTaskInput {
  missionId: string;
  crewId: string;
  title: string;
  instruction: string;
  acceptance?: string;
  dependsOn?: string[];
  /** Mimir `TaskInput.mode`; a repair task carries the mode of the task it repairs. */
  mode?: { deliverable: "diff" | "document"; access: "write" | "read"; network: "none" | "web" };
}

export interface PrRequestInput {
  title: string;
  body: string;
}

export interface PrRequestResult {
  /** Mimir gates PR creation behind a human approval; Sindri never pushes or merges. */
  status: "requested" | "awaiting_approval";
  approvalId?: string;
}

/** Every Mimir call S6 makes. All mutations carry a deterministic idempotency key. */
export interface MimirActions {
  getArtifact(artifactId: string): Promise<MimirArtifactView>;
  getMission(missionId: string): Promise<MimirMissionView>;
  sendInstruction(sessionId: string, text: string, idempotencyKey: string): Promise<void>;
  /** Retries a failed task. The key `sindri:retry:<task>:<attempt>` is shared with DeliveryLoop. */
  retry(mimirTaskId: string, attempt: number, reason: string): Promise<void>;
  createCrew(input: CreateCrewInput, idempotencyKey: string): Promise<{ crewId: string }>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<{ taskId: string }>;
  /**
   * `POST /v1/tasks/:id/pr` (approval-gated on Mimir's side). Mimir's route takes no title or
   * body, so `input` is only kept for Sindri's own records.
   */
  requestPr(
    mimirTaskId: string,
    input: PrRequestInput,
    idempotencyKey: string,
  ): Promise<PrRequestResult>;
}

/** Artifact bytes, read through Mimir's `GET /v1/artifacts/:id/content` (never its filesystem). */
export interface ArtifactContentReader {
  read(artifact: MimirArtifactView): Promise<string>;
}

/** The approved specification a plan was made from (`@sindri/specs`). */
export interface SpecView {
  id: string;
  lineageId: string;
  version: number;
  status: string;
  title: string;
  intakeId: string | null;
  acceptanceCriteria: { id: string; text: string; verification: string }[];
}

/** The ticket a specification came from (`@sindri/intake`). */
export interface IntakeView {
  id: string;
  source: string;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
}

/** Read-only access to the project's repository, for checking cited file sources. */
export interface RepoReader {
  /**
   * Line count of `path` at `commit` in the project's repository; `null` when the path does not
   * exist there (or is not a file).
   */
  lineCount(projectId: string, commit: string, path: string): Promise<number | null>;
}

export interface ContextReader {
  spec(specId: string): Promise<SpecView | undefined>;
  intake(intakeId: string): Promise<IntakeView | undefined>;
}
