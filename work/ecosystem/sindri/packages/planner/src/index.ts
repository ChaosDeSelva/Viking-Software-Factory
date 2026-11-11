export const PACKAGE_NAME = "@sindri/planner";

export {
  AREA_KINDS,
  AREA_TASK_TYPES,
  deriveWorkAreas,
  implementationDependencies,
  urlPaths,
  type AreaInput,
  type AreaKind,
  type ImplementationDependency,
  type RepoIndex,
  type WorkArea,
} from "./areas.js";
export {
  assertValidPlan,
  DEFAULT_CONCURRENCY,
  dryRun,
  estimatePlan,
  PlanValidationError,
  topoOrder,
  validatePlan,
  type DryRunOptions,
  type DryRunResult,
  type DryRunStep,
  type ValidateContext,
} from "./dag.js";
export {
  openPlanner,
  PlanStateError,
  ROLE_DEFAULTS,
  ROLE_TOKEN_BUDGETS,
  type OpenPlannerOptions,
  type Planner,
  type ProposeOptions,
  type ReviseOptions,
  type RevisePatch,
} from "./planner.js";
export { planSystem, SKELETON_MARKER } from "./prompts.js";
export { PLANNER_MIGRATIONS } from "./migrations.js";
export {
  BudgetSchema,
  DEFAULT_CAPS,
  ESCALATIONS,
  EstimatesSchema,
  MAX_TASK_LESSON_CHARS,
  PLAN_STATUSES,
  PlanSchema,
  PlanTaskSchema,
  ROLES,
  TaskIdSchema,
  TaskLessonContextSchema,
  type Budget,
  type Escalation,
  type Estimates,
  type Plan,
  type PlanStatus,
  type PlanTask,
  type ProjectCaps,
  type Role,
  type TaskLessonContext,
} from "./schema.js";
