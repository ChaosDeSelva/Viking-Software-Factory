export const PACKAGE_NAME = "@sindri/steward";

export { STEWARD_MIGRATIONS } from "./migrations.js";
export { ensureStewardSchema, purgeStewardProject, STEWARD_PROJECT_TABLES } from "./schema.js";
export {
  StewardStore,
  type DecisionPatch,
  type ListFilter,
  type NewDecision,
  type StoredDecision,
} from "./store.js";
export { Steward, type StewardLogger, type StewardOptions, type StewardStatus } from "./steward.js";
export {
  ACCEPT_AS_IS,
  allowedValues,
  APPROVAL_VALUES,
  AUTO_ESCALATION_DECISIONS,
  discover,
  ESCALATION_DECISIONS,
  heuristic,
  subjectInputs,
  type Candidate,
  type Heuristic,
} from "./producers.js";
export {
  DEFAULT_LIMITS,
  gatherLearning,
  learningInputs,
  pastSummary,
  type Learning,
  type LearningLimits,
} from "./learning.js";
export { recommendationRequest, recommendationSchema, stewardSystem } from "./prompt.js";
export { jaccard, mostSimilar, tokens } from "./similarity.js";
export type * from "./ports.js";
export {
  APPROVAL_TYPES,
  DECISION_STATUSES,
  DECISION_TYPES,
  isDecisionType,
  MODES,
  type Decision,
  type DecisionInput,
  type DecisionStatus,
  type DecisionType,
  type FgLesson,
  type Guidance,
  type HistoryEntry,
  type InputKind,
  type LessonSource,
  type Mode,
  type Note,
  type Outcome,
  type StewardType,
  type SubjectKind,
  type TypeStats,
} from "./types.js";
