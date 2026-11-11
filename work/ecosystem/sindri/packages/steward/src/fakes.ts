import { applyMigrations, KNOWLEDGE_MIGRATIONS, openDatabase } from "@sindri/knowledge";
import type {
  ActionContext,
  ApplyResult,
  DeliverySubject,
  EscalationSubject,
  PlanApprovalSubject,
  QuestionSubject,
  SpecApprovalSubject,
  StewardWorld,
} from "./ports.js";
import type { FgLesson, LessonSource, Outcome } from "./types.js";

export const PROJECT = "prj_1";
export const OTHER = "prj_2";

/** An in-memory database with the knowledge schema and two projects. */
export function testDb() {
  const db = openDatabase(":memory:");
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  const insert = db.prepare(
    `INSERT INTO projects (id, name, repo_path, created_at, updated_at)
     VALUES (?, ?, '/repos/test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert.run(PROJECT, PROJECT);
  insert.run(OTHER, OTHER);
  return db;
}

export const question = (over: Partial<QuestionSubject> = {}, q = {}): QuestionSubject => ({
  projectId: PROJECT,
  specId: "spec-1",
  lineageId: "lin-1",
  specVersion: 1,
  specStatus: "draft",
  specTitle: "Export reports",
  problem: "Users need to export reports as CSV.",
  constraints: [],
  question: { id: "Q1", text: "Which delimiter should the CSV use?", blocking: true, ...q },
  ...over,
});

export const escalation = (over: Partial<EscalationSubject> = {}): EscalationSubject => ({
  projectId: PROJECT,
  executionId: "exe-1",
  planTaskId: "T1",
  objective: "Add the export endpoint",
  escalation: "ask",
  reason: "tests failed: flaky network timeout",
  attempts: 2,
  taskStatus: "failed",
  gateFailures: [],
  ...over,
});

export const delivery = (over: Partial<DeliverySubject> = {}): DeliverySubject => ({
  projectId: PROJECT,
  executionId: "exe-9",
  specTitle: "Export reports",
  findings: [],
  gates: [{ planTaskId: "T1", passed: true, failures: [] }],
  ...over,
});

export const specReview = (over: Partial<SpecApprovalSubject> = {}): SpecApprovalSubject => ({
  projectId: PROJECT,
  specId: "spec-2",
  lineageId: "lin-2",
  version: 2,
  title: "Import reports",
  problem: "Users need to import reports.",
  blockingQuestions: [],
  acceptanceCriteria: 2,
  highRiskAssumptions: [],
  untrustedFlagged: false,
  unverifiedClaims: 0,
  ...over,
});

export const planProposed = (over: Partial<PlanApprovalSubject> = {}): PlanApprovalSubject => ({
  projectId: PROJECT,
  planId: "plan-1",
  version: 1,
  status: "draft",
  specId: "spec-3",
  specTitle: "Import reports",
  specApproved: true,
  tasks: [{ id: "T1", objective: "Implement import" }],
  problems: [],
  ...over,
});

export interface WorldCall {
  action: string;
  args: unknown[];
}

/** A scripted world: subjects are plain arrays; actions are recorded and can be made to fail. */
export class FakeWorld implements StewardWorld {
  q: QuestionSubject[] = [];
  e: EscalationSubject[] = [];
  d: DeliverySubject[] = [];
  s: SpecApprovalSubject[] = [];
  p: PlanApprovalSubject[] = [];
  entries: { projectId: string; id: string; claim: string }[] = [];
  calls: WorldCall[] = [];
  fail: Partial<Record<string, Error>> = {};
  outcomes = new Map<string, Outcome>();

  questions() {
    return this.q;
  }
  escalations() {
    return this.e;
  }
  deliveries() {
    return this.d;
  }
  specsInReview() {
    return this.s;
  }
  plansProposed() {
    return this.p;
  }
  knowledge(projectId: string) {
    return this.entries.filter((x) => x.projectId === projectId);
  }
  outcome(input: { type: string; context: unknown; appliedValue: string | null }) {
    const key = `${input.type}:${JSON.stringify(input.context)}`;
    for (const [k, v] of this.outcomes) if (key.includes(k)) return v;
    return null;
  }

  #act(action: string, args: unknown[], result: ApplyResult): Promise<ApplyResult> {
    this.calls.push({ action, args });
    const err = this.fail[action];
    return err ? Promise.reject(err) : Promise.resolve(result);
  }
  answerQuestion(s: QuestionSubject, answer: string, ctx: ActionContext) {
    // The answered question leaves the world, like a revised spec.
    this.q = this.q.filter(
      (x) => !(x.lineageId === s.lineageId && x.question.id === s.question.id),
    );
    return this.#act("answerQuestion", [s, answer, ctx], {
      reversible: true,
      data: { lineageId: s.lineageId, questionId: s.question.id, answeredSpecId: "spec-1b" },
    });
  }
  async revertAnswer(applied: Record<string, unknown>, ctx: ActionContext) {
    await this.#act("revertAnswer", [applied, ctx], { reversible: false, data: {} });
  }
  resolveEscalation(s: EscalationSubject, decision: string, reason: string, ctx: ActionContext) {
    return this.#act("resolveEscalation", [s, decision, reason, ctx], {
      reversible: false,
      data: { executionId: s.executionId, planTaskId: s.planTaskId, decision },
    });
  }
  draftRework(s: DeliverySubject, feedback: string, ctx: ActionContext) {
    return this.#act("draftRework", [s, feedback, ctx], {
      reversible: true,
      data: { executionId: s.executionId, specLineageId: "rework-lin" },
    });
  }
  async discardRework(applied: Record<string, unknown>, ctx: ActionContext) {
    await this.#act("discardRework", [applied, ctx], { reversible: false, data: {} });
  }
  approveSpec(s: SpecApprovalSubject, ctx: ActionContext) {
    return this.#act("approveSpec", [s, ctx], { reversible: false, data: { specId: s.specId } });
  }
  approvePlan(s: PlanApprovalSubject, ctx: ActionContext) {
    return this.#act("approvePlan", [s, ctx], { reversible: false, data: { planId: s.planId } });
  }
}

/** A lesson source returning fixed lessons (or throwing, to prove failures are swallowed). */
export class FakeLessons implements LessonSource {
  calls: string[] = [];
  constructor(
    public lessons: FgLesson[] = [],
    public error?: Error,
  ) {}
  lessonsFor(projectId: string): Promise<FgLesson[]> {
    this.calls.push(projectId);
    return this.error ? Promise.reject(this.error) : Promise.resolve(this.lessons);
  }
}
