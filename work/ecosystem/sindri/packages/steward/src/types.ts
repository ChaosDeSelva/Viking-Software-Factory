/** Decision types the steward recommends on. Approval types are never applied automatically. */
export const DECISION_TYPES = [
  "spec.answer",
  "escalation.resolve",
  "rework.suggest",
  "spec.approve",
  "plan.approve",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Types whose acceptance performs a human approval (needs the approval factor). */
export const APPROVAL_TYPES: ReadonlySet<DecisionType> = new Set(["spec.approve", "plan.approve"]);

export const MODES = ["off", "recommend", "auto"] as const;
export type Mode = (typeof MODES)[number];

export const DECISION_STATUSES = [
  "pending",
  "accepted",
  "changed",
  "rejected",
  "applied",
  "rolled_back",
  "expired",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type SubjectKind = "spec" | "question" | "execution" | "task" | "delivery" | "plan";

export type InputKind =
  | "spec"
  | "question"
  | "run"
  | "gate"
  | "review"
  | "note"
  | "guidance"
  | "lesson"
  | "past_decision"
  | "feedback";

export interface DecisionInput {
  kind: InputKind;
  ref: string;
  summary: string;
}

export interface Outcome {
  result: "passed" | "failed" | "reworked" | "unknown";
  detail?: string;
}

export interface Note {
  id: string;
  projectId: string | null;
  decisionId: string | null;
  author: string;
  text: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  type: DecisionType;
  subject: { kind: SubjectKind; id: string; label: string };
  inputs: DecisionInput[];
  recommendation: { value: string; detail?: string };
  reasoning: string;
  confidence: number;
  mode: "recommend" | "auto";
  status: DecisionStatus;
  outcome: Outcome | null;
  reversible: boolean;
  notes: Note[];
  createdAt: string;
  decidedAt: string | null;
  /** Additive to the contract: the value applied (the recommendation or the operator's edit). */
  appliedValue: string | null;
  /** Additive: the last failure producing or applying the recommendation, if any. */
  error: string | null;
  /** Additive: the decision's append-only change history, oldest first (single reads only). */
  history?: HistoryEntry[];
}

export interface HistoryEntry {
  action: string;
  actor: string;
  detail: unknown;
  createdAt: string;
}

export interface TypeStats {
  decided: number;
  accepted: number;
  changed: number;
  rejected: number;
  rolledBack: number;
  autoApplied: number;
  accuracy: number | null;
}

export interface StewardType {
  type: DecisionType;
  mode: Mode;
  autoAllowed: boolean;
  stats: TypeStats;
}

export interface Guidance {
  id: string;
  projectId: string;
  type: DecisionType;
  rule: string;
  decisionIds: string[];
  status: "proposed" | "accepted" | "rejected";
  entryId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
}

/** Feedback Graph lesson; mirrors `@sindri/feedback-graph`'s `FgLesson` (no dependency on it). */
export interface FgLesson {
  id: string;
  title: string;
  rule: string;
  appliesWhen: string | null;
  paths: string[];
  status: string;
}

/** Read-only lesson source; never throws, `[]` when unavailable. */
export interface LessonSource {
  lessonsFor(projectId: string, opts?: { limit?: number }): Promise<FgLesson[]>;
}

export const isDecisionType = (v: string): v is DecisionType =>
  (DECISION_TYPES as readonly string[]).includes(v);
