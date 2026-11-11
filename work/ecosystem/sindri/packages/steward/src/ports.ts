import type { Outcome } from "./types.js";

/** An open question on the latest draft or review version of a spec lineage. */
export interface QuestionSubject {
  projectId: string;
  specId: string;
  lineageId: string;
  specVersion: number;
  specStatus: string;
  specTitle: string;
  problem: string;
  constraints: string[];
  question: {
    id: string;
    text: string;
    blocking: boolean;
    recommendation?: string;
    rationale?: string;
  };
}

/** A task the run escalated, while its execution is still open. */
export interface EscalationSubject {
  projectId: string;
  executionId: string;
  planTaskId: string;
  objective: string | null;
  escalation: string;
  reason: string | null;
  attempts: number;
  taskStatus: string;
  /** Gate failures recorded for this task (`code: message`). */
  gateFailures: string[];
}

/** A verified delivery whose quality assessment has run. */
export interface DeliverySubject {
  projectId: string;
  executionId: string;
  specTitle: string | null;
  findings: { severity: string; message: string; role?: string }[];
  gates: { planTaskId: string; passed: boolean; failures: string[] }[];
}

/** The latest version of a spec lineage, in review. */
export interface SpecApprovalSubject {
  projectId: string;
  specId: string;
  lineageId: string;
  version: number;
  title: string;
  problem: string;
  blockingQuestions: string[];
  acceptanceCriteria: number;
  highRiskAssumptions: string[];
  untrustedFlagged: boolean;
  unverifiedClaims: number;
}

/** The latest version of a plan lineage, proposed (draft) or in review. */
export interface PlanApprovalSubject {
  projectId: string;
  planId: string;
  version: number;
  status: string;
  specId: string;
  specTitle: string | null;
  specApproved: boolean;
  tasks: { id: string; objective: string }[];
  /** Problems a dry run reports (empty when it is clean). */
  problems: string[];
}

export type Subject =
  | { type: "spec.answer"; data: QuestionSubject }
  | { type: "escalation.resolve"; data: EscalationSubject }
  | { type: "rework.suggest"; data: DeliverySubject }
  | { type: "spec.approve"; data: SpecApprovalSubject }
  | { type: "plan.approve"; data: PlanApprovalSubject };

/** What applying a decision did: ids a rollback needs, and whether it can be rolled back. */
export interface ApplyResult {
  reversible: boolean;
  data: Record<string, unknown>;
}

/** Who performs an action, and the approval secret for approval types. */
export interface ActionContext {
  actor: string;
  approval?: string;
}

/**
 * Everything the steward reads from and does to the rest of Sindri. The server implements it
 * over its services; tests use a fake. Readers return current state only; actions go through
 * the same code paths an operator's own request would.
 */
export interface StewardWorld {
  questions(): QuestionSubject[];
  escalations(): EscalationSubject[];
  deliveries(): DeliverySubject[];
  specsInReview(): SpecApprovalSubject[];
  plansProposed(): PlanApprovalSubject[];
  /** Approved (valid) knowledge entries of a project. */
  knowledge(projectId: string): { id: string; claim: string }[];
  /** The later result of an applied decision, or null while it is not known yet. */
  outcome(input: {
    type: string;
    context: unknown;
    appliedValue: string | null;
    applied: Record<string, unknown> | null;
  }): Outcome | null;

  answerQuestion(s: QuestionSubject, answer: string, ctx: ActionContext): Promise<ApplyResult>;
  /** Throws a SindriError `invalid_state` when the answer can no longer be undone. */
  revertAnswer(applied: Record<string, unknown>, ctx: ActionContext): Promise<void>;
  resolveEscalation(
    s: EscalationSubject,
    decision: string,
    reason: string,
    ctx: ActionContext,
  ): Promise<ApplyResult>;
  draftRework(s: DeliverySubject, feedback: string, ctx: ActionContext): Promise<ApplyResult>;
  /** Throws a SindriError `invalid_state` when the drafted spec was approved meanwhile. */
  discardRework(applied: Record<string, unknown>, ctx: ActionContext): Promise<void>;
  approveSpec(s: SpecApprovalSubject, ctx: ActionContext): Promise<ApplyResult>;
  approvePlan(s: PlanApprovalSubject, ctx: ActionContext): Promise<ApplyResult>;
}
