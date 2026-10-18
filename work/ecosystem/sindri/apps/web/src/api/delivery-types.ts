// Wire types for plans, harnesses, executions, reviews and deliveries (server S7b routes).

export type PlanStatus = "draft" | "review" | "approved" | "superseded";
export type Role =
  "lead" | "implementer" | "reviewer" | "qa" | "investigator" | "security" | "docs";

export interface PlanTask {
  id: string;
  objective: string;
  inputs: string[];
  outputs: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  harnessId: string;
  harnessVersion: string;
  harnessLockDigest: string;
  skills: string[];
  selectionRationale: string[];
  role: Role;
  budget: { tokens?: number; costUsd?: number; wallClockMinutes: number };
  maxRetries: number;
  escalation: "block" | "ask" | "replan";
}

export interface Plan {
  id: string;
  projectId: string;
  lineageId: string;
  specId: string;
  specVersion: number;
  version: number;
  status: PlanStatus;
  tasks: PlanTask[];
  estimates: {
    taskCount: number;
    wallClockMinutes: number;
    criticalPathMinutes: number;
    tokens: number;
    costUsd: number | null;
  };
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface PlanVersion {
  id: string;
  version: number;
  status: PlanStatus;
  specId: string;
  specVersion: number;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface DryRun {
  steps: { step: number; tasks: { id: string; role: Role }[] }[];
  order: string[];
}

export type HarnessSource = "fake" | "brokkr" | "custom";

export interface HarnessSummary {
  name: string;
  version: string;
  description: string;
  taskTypes: string[];
  skills: { required: string[]; optional: string[] };
  checks: { id: string; required: boolean }[];
}

export interface RepoSignals {
  packageManager: string | null;
  frameworks: string[];
  scripts: string[];
  hasTsconfig: boolean;
  testRunners: string[];
}

export interface Selection {
  harnesses: { name: string; version: string; digest: string; description: string }[];
  skills: { name: string; version: string; reason: string; score: number }[];
  lock: { digest: string };
  rationale: { kind: "harness" | "skill"; name: string; selected: boolean; reason: string }[];
}

export interface ExplainInput {
  projectId?: string;
  task: { id: string; title: string; description: string; taskTypes?: string[] };
}

export type ExecutionStatus =
  | "pending"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "replan_requested"
  | "verified_pending_review"
  | "delivered_pending_merge"
  | "cancelled"
  | "failed";

export interface Execution {
  id: string;
  planId: string;
  planVersion: number;
  mimirMissionId: string;
  status: ExecutionStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  projectId?: string | null;
}

export interface ExecutionSummary {
  id: string;
  planId: string;
  planVersion: number;
  projectId: string;
  status: ExecutionStatus;
  mimirMissionId: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface ExecutionTask {
  id: string;
  planTaskId: string;
  mimirTaskId: string;
  status: string;
  attempts: number;
  escalation: "block" | "ask" | "replan" | null;
  escalationReason: string | null;
}

export interface ExecutionApproval {
  id: string;
  executionId: string;
  mimirApprovalId: string;
  planTaskId: string | null;
  action: string;
  reason: string | null;
  disposition: "inbox" | "auto_rejected";
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedAt: string | null;
}

export interface ArtifactRef {
  id: string;
  mimirArtifactId: string;
  planTaskId: string | null;
  kind: string;
  sha256: string;
  uri: string;
}

export interface ExecutionDetail {
  execution: Execution;
  tasks: ExecutionTask[];
  approvals: ExecutionApproval[];
  artifacts: ArtifactRef[];
  plan: {
    id: string;
    version: number;
    specId: string;
    tasks: { id: string; objective: string; role: Role; dependsOn: string[] }[];
  } | null;
  links: {
    mission: string | null;
    agents?: { planTaskId: string; sessionId: string; url: string | null }[];
  };
  gates: TaskGate[];
  running: boolean;
}

export interface ExecutionEvent {
  id: string;
  mimirEventId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
}

/** One frame of the execution SSE relay. */
export type ExecutionStreamMessage =
  | { kind: "snapshot"; data: { execution: Execution; tasks: ExecutionTask[] } }
  | { kind: "event"; data: ExecutionEvent }
  | { kind: "notice"; data: { type: string; executionId: string; [k: string]: unknown } };

export type DeliveryServiceKind = "s6" | "custom";

export interface GateFailure {
  gateId: string;
  reason: string;
  evidenceRef?: string;
}

export interface TaskGate {
  planTaskId: string;
  passed: boolean;
  engineering: { verdict: string; reportArtifactId: string } | null;
  failures: GateFailure[];
  evaluatedAt: string;
}

export type EscalationDecision = "retry" | "skip" | "replan" | "abort";

export interface ReviewsInbox {
  deliveryService: DeliveryServiceKind;
  approvals: ExecutionApproval[];
  escalations: {
    executionId: string;
    planTaskId: string;
    escalation: "block" | "ask" | "replan";
    reason: string | null;
    status: string;
    attempts: number;
  }[];
  budgetAlerts: { id: string; executionId: string; planTaskId: string | null; detail: unknown }[];
  gateFailures: (GateFailure & { executionId: string; planTaskId: string; evaluatedAt: string })[];
  findings: {
    executionId: string;
    reviewId: string;
    planTaskId: string;
    role: string;
    verdict: string | null;
    severity: string;
    message: string;
    file?: string;
    line?: number;
  }[];
}

/** `@sindri/delivery` DeliveryReport (S6), as served by GET /v1/deliveries/:id. */
export interface DeliveryReport {
  id: string;
  executionId: string;
  projectId: string;
  status: "built" | "delivered_pending_merge";
  createdAt: string;
  deliveredAt: string | null;
  spec: { id: string; lineageId: string; version: number; title: string; intakeId: string | null };
  plan: { id: string; version: number };
  missionId: string;
  requirements: {
    criterionId: string;
    text: string;
    verification: string;
    status: "satisfied" | "unsatisfied" | "unverified";
    tasks: { planTaskId: string; mimirTaskId: string | null; gatePassed: boolean | null }[];
    evidence: string[];
  }[];
  tasks: {
    planTaskId: string;
    mimirTaskId: string | null;
    role: string;
    status: string;
    harness: { id: string; version: string; lockDigest: string };
    gate: { evaluationId: string; passed: boolean; failures: GateFailure[] } | null;
    brokkr: { verdict: string; reportArtifactId: string } | null;
  }[];
  summary: { sentences: { text: string }[]; stripped: { text: string; reason?: string }[] };
  changedFiles: { planTaskId: string | null; path: string; status: string | null }[];
  testResults: {
    eventId: string;
    planTaskId: string | null;
    command: string;
    passed: boolean;
    exitCode: number | null;
    durationMs: number | null;
  }[];
  screenshots: { artifactId: string; planTaskId: string | null; kind: string; uri: string }[];
  reviews: {
    reviewId: string;
    planTaskId: string;
    role: string;
    verdict: string | null;
    reason: string | null;
    findings: { severity: string; message: string }[];
  }[];
  limitations: string[];
  rollback: {
    branches: { planTaskId: string; branch: string; baseSha: string }[];
    commits: { eventId: string; sha: string; branch: string }[];
    note: string;
  };
}

export interface DeliveryDetail {
  deliveryService: DeliveryServiceKind;
  report: DeliveryReport;
  prDescription: string;
}

export interface LocalDelivery {
  baseSha: string;
  resultCommit: string;
  patch: string;
  repoPath: string;
  apply: string;
  undo: string;
}

interface TraceEvent {
  id: string;
  type: string;
  occurredAt: string;
}
interface TraceArtifact {
  id: string;
  kind: string;
  hash: string;
}
interface TraceReview {
  reviewId: string;
  ofPlanTaskId: string;
  status: string;
  verdict: string | null;
}

/** `@sindri/delivery` TraceDocument (S6). */
export interface TraceDocument {
  schemaVersion: 1;
  delivery: { id: string; status: string; prs: { planTaskId: string; status: string }[] };
  ticket: { id: string; title: string; source?: string; externalId?: string | null } | null;
  spec: { id: string; version: number; title: string; status: string };
  plan: { id: string; version: number };
  mission: { id: string };
  execution: { id: string; status: string };
  tasks: {
    planTaskId: string;
    mimirTaskId: string | null;
    role: string;
    status: string;
    harness: { id: string; version: string };
    gate: { passed: boolean } | null;
    reviews: TraceReview[];
    events: TraceEvent[];
    artifacts: TraceArtifact[];
  }[];
  reviewTasks: {
    mimirTaskId: string;
    review: TraceReview;
    events: TraceEvent[];
    artifacts: TraceArtifact[];
  }[];
  unattributedEvents: TraceEvent[];
}

/** A display tree derived from a TraceDocument. */
export interface TraceNode {
  kind: string;
  id: string;
  label: string;
  children: TraceNode[];
}

export interface PrDelivery {
  deliveryId: string;
  status: string;
  prs: { planTaskId: string; mimirTaskId: string; status: string; approvalId?: string }[];
}

export interface MimirStatus {
  configured: boolean;
  url: string | null;
  tokenSecret: string | null;
  blocked: "local_only" | null;
  reachable: boolean | null;
  serverVersion: string | null;
  error: string | null;
}
