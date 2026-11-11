import type {
  DeliverySubject,
  EscalationSubject,
  PlanApprovalSubject,
  QuestionSubject,
  SpecApprovalSubject,
  StewardWorld,
  Subject,
} from "./ports.js";
import type { DecisionInput, DecisionType, SubjectKind } from "./types.js";

/** One thing the steward could recommend on, found in Sindri's current state. */
export interface Candidate {
  type: DecisionType;
  projectId: string;
  dedupeKey: string;
  subject: { kind: SubjectKind; id: string; label: string };
  data: Subject["data"];
}

/** A recommendation made without a provider call. */
export interface Heuristic {
  value: string;
  detail?: string;
  reasoning: string;
  confidence: number;
}

export const ESCALATION_DECISIONS = ["retry", "skip", "replan", "abort"] as const;
/** The only escalation answers auto mode may apply. */
export const AUTO_ESCALATION_DECISIONS: ReadonlySet<string> = new Set(["retry", "skip"]);
export const APPROVAL_VALUES = ["approve", "hold"] as const;
/** `rework.suggest` value meaning "accept the delivery as is"; anything else is change text. */
export const ACCEPT_AS_IS = "accept";

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Values a type accepts, or null for free text. */
export function allowedValues(type: DecisionType): readonly string[] | null {
  switch (type) {
    case "escalation.resolve":
      return ESCALATION_DECISIONS;
    case "spec.approve":
    case "plan.approve":
      return APPROVAL_VALUES;
    default:
      return null;
  }
}

/** Every candidate in the world for the enabled types. A failing reader skips its type. */
export function discover(
  world: StewardWorld,
  enabled: (type: DecisionType) => boolean,
  onError: (type: DecisionType, err: unknown) => void = () => {},
): { candidates: Candidate[]; scanned: Set<DecisionType> } {
  const candidates: Candidate[] = [];
  const scanned = new Set<DecisionType>();
  const scan = <T>(type: DecisionType, read: () => T[], map: (s: T) => Candidate) => {
    if (!enabled(type)) return;
    try {
      candidates.push(...read().map(map));
      scanned.add(type);
    } catch (err) {
      onError(type, err);
    }
  };
  scan("spec.answer", () => world.questions(), questionCandidate);
  scan("escalation.resolve", () => world.escalations(), escalationCandidate);
  scan("rework.suggest", () => world.deliveries(), deliveryCandidate);
  scan("spec.approve", () => world.specsInReview(), specCandidate);
  scan("plan.approve", () => world.plansProposed(), planCandidate);
  return { candidates, scanned };
}

const questionCandidate = (q: QuestionSubject): Candidate => ({
  type: "spec.answer",
  projectId: q.projectId,
  // A question keeps its id across the lineage's versions (answering one revises the spec).
  dedupeKey: `${q.lineageId}:${q.question.id}`,
  subject: {
    kind: "question",
    id: `${q.lineageId}:${q.question.id}`,
    label: clip(`${q.specTitle}: ${q.question.text}`, 300),
  },
  data: q,
});

const escalationCandidate = (e: EscalationSubject): Candidate => ({
  type: "escalation.resolve",
  projectId: e.projectId,
  // A task can escalate again after a retry: each attempt is its own subject.
  dedupeKey: `${e.executionId}:${e.planTaskId}:${e.attempts}`,
  subject: {
    kind: "task",
    id: `${e.executionId}:${e.planTaskId}`,
    label: clip(
      `${e.planTaskId}${e.objective ? ` (${e.objective})` : ""}: ${e.reason ?? e.escalation}`,
      300,
    ),
  },
  data: e,
});

const deliveryCandidate = (d: DeliverySubject): Candidate => ({
  type: "rework.suggest",
  projectId: d.projectId,
  dedupeKey: d.executionId,
  subject: {
    kind: "delivery",
    id: d.executionId,
    label: clip(`Delivery of ${d.specTitle ?? d.executionId}`, 300),
  },
  data: d,
});

const specCandidate = (s: SpecApprovalSubject): Candidate => ({
  type: "spec.approve",
  projectId: s.projectId,
  dedupeKey: s.specId,
  subject: { kind: "spec", id: s.specId, label: clip(`${s.title} (v${s.version})`, 300) },
  data: s,
});

const planCandidate = (p: PlanApprovalSubject): Candidate => ({
  type: "plan.approve",
  projectId: p.projectId,
  dedupeKey: p.planId,
  subject: {
    kind: "plan",
    id: p.planId,
    label: clip(`Plan v${p.version} for ${p.specTitle ?? p.specId}`, 300),
  },
  data: p,
});

/** The subject's own inputs (recorded on the decision before the learning inputs). */
export function subjectInputs(c: Candidate): DecisionInput[] {
  switch (c.type) {
    case "spec.answer": {
      const q = c.data as QuestionSubject;
      return [
        { kind: "spec", ref: `spec:${q.specId}`, summary: clip(`${q.specTitle}: ${q.problem}`) },
        {
          kind: "question",
          ref: `question:${q.specId}#${q.question.id}`,
          summary: clip(
            `${q.question.text}${q.question.recommendation ? ` (drafter suggests: ${q.question.recommendation})` : ""}`,
          ),
        },
      ];
    }
    case "escalation.resolve": {
      const e = c.data as EscalationSubject;
      return [
        {
          kind: "run",
          ref: `execution:${e.executionId}#${e.planTaskId}`,
          summary: clip(
            `${e.escalation} escalation after ${e.attempts} attempt(s), task ${e.taskStatus}: ${e.reason ?? "no reason recorded"}`,
          ),
        },
        ...e.gateFailures.map((g, i): DecisionInput => ({
          kind: "gate",
          ref: `gate:${e.executionId}#${e.planTaskId}:${i}`,
          summary: clip(g),
        })),
      ];
    }
    case "rework.suggest": {
      const d = c.data as DeliverySubject;
      return [
        ...d.findings.map((f, i): DecisionInput => ({
          kind: "review",
          ref: `review:${d.executionId}:${i}`,
          summary: clip(`${f.severity}${f.role ? ` (${f.role})` : ""}: ${f.message}`),
        })),
        ...d.gates.map((g): DecisionInput => ({
          kind: "gate",
          ref: `gate:${d.executionId}#${g.planTaskId}`,
          summary: clip(
            `${g.planTaskId}: ${g.passed ? "passed" : "failed"}${g.failures.length ? ` (${g.failures.join("; ")})` : ""}`,
          ),
        })),
      ];
    }
    case "spec.approve": {
      const s = c.data as SpecApprovalSubject;
      return [
        {
          kind: "spec",
          ref: `spec:${s.specId}`,
          summary: clip(
            `${s.title} v${s.version}: ${s.acceptanceCriteria} acceptance criteria, ${s.blockingQuestions.length} blocking question(s), ${s.highRiskAssumptions.length} high-risk assumption(s), ${s.unverifiedClaims} unverified claim(s)${s.untrustedFlagged ? ", flagged instructions in its sources" : ""}`,
          ),
        },
      ];
    }
    case "plan.approve": {
      const p = c.data as PlanApprovalSubject;
      return [
        {
          kind: "spec",
          ref: `plan:${p.planId}`,
          summary: clip(
            `plan v${p.version} (${p.status}) with ${p.tasks.length} task(s) for ${p.specApproved ? "an approved" : "an unapproved"} spec${p.untrustedFlagged ? ", flagged instructions in its input" : ""}${p.problems.length ? `; dry run: ${p.problems.join("; ")}` : ""}`,
          ),
        },
      ];
    }
  }
}

/**
 * A recommendation that needs no provider call: the drafter's own suggestion for a question,
 * hard blockers on an approval, or a clean delivery. Null when the provider should decide.
 */
export function heuristic(c: Candidate): Heuristic | null {
  switch (c.type) {
    case "spec.answer": {
      const q = (c.data as QuestionSubject).question;
      if (!q.recommendation) return null;
      return {
        value: q.recommendation,
        reasoning: q.rationale
          ? `The drafter suggested this answer: ${q.rationale}`
          : "The drafter suggested this answer.",
        confidence: 0.6,
      };
    }
    case "spec.approve": {
      const s = c.data as SpecApprovalSubject;
      const blockers = [
        ...(s.blockingQuestions.length
          ? [`blocking open questions remain (${s.blockingQuestions.join(", ")})`]
          : []),
        ...(s.acceptanceCriteria === 0 ? ["it has no acceptance criteria"] : []),
        ...(s.untrustedFlagged
          ? ["its sources contained flagged instructions a person must review"]
          : []),
      ];
      if (blockers.length === 0) return null;
      return {
        value: "hold",
        detail: blockers.join("; "),
        reasoning: `Hold: ${blockers.join("; ")}.`,
        confidence: 0.9,
      };
    }
    case "plan.approve": {
      const p = c.data as PlanApprovalSubject;
      const blockers = [
        ...(!p.specApproved ? ["its specification is not approved"] : []),
        ...(p.tasks.length === 0 ? ["it has no tasks"] : []),
        ...(p.untrustedFlagged
          ? ["it was built from text with flagged instructions a person must review"]
          : []),
        ...p.problems.map((x) => `dry run: ${x}`),
      ];
      if (blockers.length === 0) return null;
      return {
        value: "hold",
        detail: blockers.join("; "),
        reasoning: `Hold: ${blockers.join("; ")}.`,
        confidence: 0.9,
      };
    }
    case "rework.suggest": {
      const d = c.data as DeliverySubject;
      if (d.findings.length > 0 || d.gates.some((g) => !g.passed || g.failures.length > 0))
        return null;
      return {
        value: ACCEPT_AS_IS,
        reasoning: "Every gate passed and the reviews raised no findings.",
        confidence: 0.7,
      };
    }
    default:
      return null;
  }
}

/** Type-specific instructions for the recommendation prompt. */
export function typeInstructions(type: DecisionType): string {
  switch (type) {
    case "spec.answer":
      return 'Recommend an answer to the open specification question. "value" is the answer itself, written so it can be accepted unchanged. If the drafter suggested an answer, keep it unless the notes, guidance, lessons or past decisions point elsewhere.';
    case "escalation.resolve":
      return 'Recommend how to resolve the escalated task. "value" is exactly one of: retry (try once more; good when the failure looks transient or fixable by another attempt), skip (continue without this task), replan (the plan itself is wrong for this task), abort (stop the run). Weigh the attempts used, the failure reason, gate results and how the operator resolved similar failures before. "detail" is the reason to record with the resolution.';
    case "rework.suggest":
      return `Recommend whether to accept the verified delivery as is or to request changes. "value" is exactly "${ACCEPT_AS_IS}" to accept as is; otherwise "value" is the change request itself: the reviewer feedback to draft a rework from, specific and actionable. Base it on the review findings and gate advisories.`;
    case "spec.approve":
      return 'Recommend whether a person should approve the specification now. "value" is exactly "approve" or "hold"; "detail" lists what must change first when you recommend hold. You only recommend: a person approves.';
    case "plan.approve":
      return 'Recommend whether a person should approve the plan now. "value" is exactly "approve" or "hold"; "detail" lists what must change first when you recommend hold. You only recommend: a person approves.';
  }
}
