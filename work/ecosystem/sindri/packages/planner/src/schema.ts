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
