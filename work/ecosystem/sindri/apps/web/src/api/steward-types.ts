// Wire types for the steward (Autonomy) and Feedback Graph routes. Every enum also accepts an
// unknown string: the server and the web app ship separately, so the UI shows new values raw.

/** A string enum that tolerates values this build does not know yet. */
type Open<T extends string> = T | (string & {});

export type StewardDecisionType = Open<
  "spec.answer" | "escalation.resolve" | "rework.suggest" | "spec.approve" | "plan.approve"
>;
export type StewardMode = Open<"off" | "recommend" | "auto">;
export type DecisionStatus = Open<
  "pending" | "accepted" | "changed" | "rejected" | "applied" | "rolled_back" | "expired"
>;
export type SubjectKind = Open<"spec" | "question" | "execution" | "task" | "delivery" | "plan">;
export type InputKind = Open<
  | "spec"
  | "question"
  | "run"
  | "gate"
  | "review"
  | "note"
  | "guidance"
  | "lesson"
  | "past_decision"
  | "feedback"
>;
export type OutcomeResult = Open<"passed" | "failed" | "reworked" | "unknown">;
export type FgLinkSource = Open<"auto" | "override" | "none">;

export interface FeedbackGraphStatus {
  configured: boolean;
  enabled: boolean;
  url: string | null;
  reachable: boolean | null;
  error: string | null;
}

export interface StewardTypeStats {
  decided: number;
  accepted: number;
  changed: number;
  rejected: number;
  rolledBack: number;
  autoApplied: number;
  /** 0..1, null before anything was decided. */
  accuracy: number | null;
}

export interface StewardType {
  type: StewardDecisionType;
  mode: StewardMode;
  /** False for approval types: they can only ever recommend. */
  autoAllowed: boolean;
  stats: StewardTypeStats;
}

export interface StewardStatus {
  running: boolean;
  types: StewardType[];
  feedbackGraph: FeedbackGraphStatus;
}

export interface StewardNote {
  id: string;
  /** null = a global note. */
  projectId: string | null;
  decisionId: string | null;
  author: string;
  text: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  type: StewardDecisionType;
  subject: { kind: SubjectKind; id: string; label: string };
  inputs: { kind: InputKind; ref: string; summary: string }[];
  recommendation: { value: string; detail?: string };
  reasoning: string;
  /** 0..1 */
  confidence: number;
  mode: StewardMode;
  status: DecisionStatus;
  outcome: { result: OutcomeResult; detail?: string } | null;
  reversible: boolean;
  notes: StewardNote[];
  createdAt: string;
  decidedAt: string | null;
}

export interface DecisionQuery {
  projectId?: string;
  type?: string;
  status?: string;
  limit?: number;
  before?: string;
}

export interface FgLesson {
  id: string;
  title: string;
  rule: string;
  appliesWhen: string | null;
  paths: string[];
  status: string;
}

export interface ProjectFeedbackGraph {
  link: { projectKey: string | null; source: FgLinkSource };
  lessons: FgLesson[];
  error: string | null;
}

/** Decision types whose acceptance performs an approval, so it needs the approval factor. */
export const APPROVAL_DECISION_TYPES: readonly string[] = ["spec.approve", "plan.approve"];
/** Decision types known not to be approvals. */
export const PLAIN_DECISION_TYPES: readonly string[] = [
  "spec.answer",
  "escalation.resolve",
  "rework.suggest",
];

/**
 * Whether accepting a decision of this type needs the approval factor. A type this build does
 * not know is treated as an approval: the server may have added one (approvals are never
 * automatic), and sending the factor to an accept route that does not need it is harmless.
 */
export const acceptNeedsApproval = (type: string) => !PLAIN_DECISION_TYPES.includes(type);
