export const PACKAGE_NAME = "@sindri/feedback-graph";

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  FeedbackGraphClient,
  type FgClientOptions,
} from "./client.js";
export {
  MAX_APPLIES_WHEN_CHARS,
  MAX_LESSONS,
  MAX_PATH_CHARS,
  MAX_PATHS,
  MAX_RULE_CHARS,
  MAX_TITLE_CHARS,
  normalizeLesson,
  normalizeLessons,
} from "./normalize.js";
export {
  CACHE_TTL_MS,
  createFeedbackGraphService,
  DEFAULT_LESSON_LIMIT,
  FAILURE_TTL_MS,
  PROJECT_KEY,
  PROJECT_OVERRIDE_KEY,
  STATUS_TTL_MS,
  type FeedbackGraphService,
  type FeedbackGraphServiceOptions,
  type FgProjectRef,
} from "./service.js";
export type {
  FgConfig,
  FgError,
  FgErrorCode,
  FgLesson,
  FgLink,
  FgLinkSource,
  FgProjectView,
  FgResult,
  FgStatus,
  SecretReader,
} from "./types.js";
