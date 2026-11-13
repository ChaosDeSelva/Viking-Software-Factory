import { SelectionSchema } from "@sindri/harnesses";
import { z } from "zod";

/** Agent roles a plan task may take. There is deliberately no `delegate` role. */
export const ROLES = [
  "lead",
  "implementer",
  "reviewer",
  "qa",
  "investigator",
  "security",
  "docs",
] as const;
export type Role = (typeof ROLES)[number];

export const ESCALATIONS = ["block", "ask", "replan"] as const;
export type Escalation = (typeof ESCALATIONS)[number];

export const PLAN_STATUSES = ["draft", "review", "approved", "superseded"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TaskIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "task ids are [A-Za-z0-9._-], starting alphanumeric");

export const BudgetSchema = z
  .object({
    tokens: z.number().int().positive().optional(),
    costUsd: z.number().positive().optional(),
    wallClockMinutes: z.number().int().positive(),
  })
  .strict();
export type Budget = z.infer<typeof BudgetSchema>;

const LessonIdSchema = z.string().regex(/^fg:[\w.:@/#-]{1,200}$/);

/** Stored lesson text is cut to this many characters per lesson. */
export const MAX_TASK_LESSON_CHARS = 2000;

export const TaskLessonContextSchema = z
  .object({
    id: LessonIdSchema,
    title: z.string().max(200),
    text: z.string().max(MAX_TASK_LESSON_CHARS),
  })
  .strict();
export type TaskLessonContext = z.infer<typeof TaskLessonContextSchema>;

export const PlanTaskSchema = z
  .object({
    id: TaskIdSchema,
    priority: z.number().int().min(0).max(100).optional(),
    objective: z.string().trim().min(1),
    inputs: z.array(z.string()),
    outputs: z.array(z.string()),
    /** Acceptance-criterion ids from the specification. */
    acceptanceCriteria: z.array(z.string().min(1)),
    dependsOn: z.array(TaskIdSchema),
    /** Primary Brokkr harness for this task, pinned to an exact version. */
    harnessId: z.string().min(1),
    harnessVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "harnessVersion must be an exact version"),
    /** Brokkr `lock.digest` for the full selection, so Mimir verifies the exact harness set. */
    harnessSelection: SelectionSchema.optional(),
    harnessLockDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, "harnessLockDigest must be sha256:<64 hex>"),
    /** Skills Brokkr selected for this task. */
    skills: z.array(z.string().min(1)),
    /** `explainSelection` output for the Brokkr selection. */
    selectionRationale: z.array(z.string()),
    role: z.enum(ROLES),
    budget: BudgetSchema,
    maxRetries: z.number().int().min(0),
    escalation: z.enum(ESCALATIONS),
    /** Feedback Graph lessons (`fg:<id>`) the planner was given and this task must follow. */
    lessons: z.array(LessonIdSchema).max(20).optional(),
    /** Redacted text of the cited lessons as planned, for the agent brief; set by the planner. */
    lessonContext: z.array(TaskLessonContextSchema).max(20).optional(),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const EstimatesSchema = z.object({
  taskCount: z.number().int().nonnegative(),
  wallClockMinutes: z.number().nonnegative(),
  criticalPathMinutes: z.number().nonnegative(),
  tokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type Estimates = z.infer<typeof EstimatesSchema>;

/** What a plan delivers; the intake's work kind decides the skeleton. */
export const WORK_KINDS = ["change", "research", "pr_review"] as const;
export type PlanWorkKind = (typeof WORK_KINDS)[number];

export const MAX_RESEARCH_QUESTION_CHARS = 8000;
/** The earlier document a follow-up question carries as context, at most this long. */
export const MAX_FOLLOW_UP_CONTEXT_CHARS = 24_000;
export const CONTEXT_TRUNCATED_MARKER = "\n[earlier document truncated]";

export const ResearchPlanSchema = z
  .object({
    sources: z.object({ code: z.boolean(), feedbackGraph: z.boolean(), web: z.boolean() }).strict(),
    factCheck: z.boolean(),
    /** The request as asked (title and body, secrets redacted), for the research brief. */
    question: z.string().max(MAX_RESEARCH_QUESTION_CHARS).optional(),
    /** A follow-up's earlier document (secrets redacted, cut with a marker), loaded at planning. */
    context: z
      .object({
        executionId: z.string().min(1),
        document: z.string().max(MAX_FOLLOW_UP_CONTEXT_CHARS + 64),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Changed paths a PR review plan keeps: GitHub lists at most 3000 (the rest are counted). */
export const MAX_PR_REVIEW_FILES = 3000;
export const MAX_PR_BODY_CHARS = 16_000;

/**
 * The pull request a PR review plan reviews, pinned to its base and head commits. `title` and
 * `body` are untrusted PR text (secrets redacted); the brief wraps them in data delimiters with
 * `nonce`.
 */
export const PrReviewPlanSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    number: z.number().int().positive(),
    url: z.string().url().max(300),
    title: z.string().max(1000),
    body: z.string().max(MAX_PR_BODY_CHARS),
    author: z.string().max(100).nullable(),
    baseRef: z.string().max(255),
    headRef: z.string().max(255),
    baseSha: ShaSchema,
    headSha: ShaSchema,
    isCrossRepository: z.boolean(),
    files: z.array(z.string().max(1000)).max(MAX_PR_REVIEW_FILES),
    filesOmitted: z.number().int().nonnegative(),
    nonce: z.string().regex(/^[0-9a-z]{6,64}$/i),
  })
  .strict();
export type PrReviewPlan = z.infer<typeof PrReviewPlanSchema>;

export const PlanWorkSchema = z
  .object({
    kind: z.enum(WORK_KINDS),
    research: ResearchPlanSchema.optional(),
    prReview: PrReviewPlanSchema.optional(),
  })
  .strict();
export type PlanWork = z.infer<typeof PlanWorkSchema>;

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Operator guidance as planned (see `@sindri/knowledge` `GuidanceSnapshot`). */
export const GuidanceSnapshotSchema = z
  .object({
    skills: z.array(
      z
        .object({ id: z.string(), name: z.string(), digest: DigestSchema, content: z.string() })
        .strict(),
    ),
    omitted: z.array(z.object({ id: z.string(), name: z.string(), digest: DigestSchema }).strict()),
    projectNotes: z.string(),
    requestNotes: z.string(),
    projectNotesDigest: DigestSchema.nullable(),
    requestNotesDigest: DigestSchema.nullable(),
  })
  .strict();

export const PlanSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  lineageId: z.string().min(1),
  specId: z.string().min(1),
  specVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  status: z.enum(PLAN_STATUSES),
  tasks: z.array(PlanTaskSchema).min(1),
  estimates: EstimatesSchema,
  /** Set when untrusted planner input (lessons) held an injection; sticky across revisions. */
  untrustedInstructionDetected: z.boolean().optional(),
  injectionFindings: z.array(z.object({ source: z.string(), patternId: z.string() })).optional(),
  /** Absent on plans from before work kinds: those are code changes. */
  work: PlanWorkSchema.optional(),
  /** The operator guidance every brief of this plan carries. */
  guidance: GuidanceSnapshotSchema.optional(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Project-level ceilings. Undefined means "no cap". */
export interface ProjectCaps {
  maxTasks?: number;
  maxRetries?: number;
  maxTaskWallClockMinutes?: number;
  maxTaskTokens?: number;
  maxTaskCostUsd?: number;
  maxTotalWallClockMinutes?: number;
  maxTotalTokens?: number;
  maxTotalCostUsd?: number;
}

export const DEFAULT_CAPS: ProjectCaps = {
  maxTasks: 20,
  maxRetries: 3,
  maxTaskWallClockMinutes: 120,
  maxTaskTokens: 1_000_000,
  maxTotalWallClockMinutes: 900,
  maxTotalTokens: 8_000_000,
};
