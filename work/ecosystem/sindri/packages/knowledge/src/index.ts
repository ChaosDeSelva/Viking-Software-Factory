export const PACKAGE_NAME = "@sindri/knowledge";

export { isSindriError, SindriError, SINDRI_ERROR_STATUS, type SindriErrorCode } from "./errors.js";
export { applyMigrations, openDatabase, type SqliteDatabase } from "./db.js";
export { chunkText, DEFAULT_CHUNK_SIZE, type TextChunk } from "./chunk.js";
export {
  classify,
  isSecretPath,
  isUnsafeName,
  auditGitConfig,
  gitConfigFindings,
  UnsafeGitConfigError,
  MAX_PATH_LENGTH,
  listCandidateFiles,
  DEFAULT_EXCLUDES,
  MAX_FILE_BYTES,
  SECRET_PATTERNS,
  STRUCTURE_DEPTH,
  type BootstrapOptions,
  type BootstrapResult,
  type DocumentKind,
  type SkipReason,
} from "./bootstrap.js";
export { hardenedGitEnv, HARDENED_GIT_CONFIG } from "./git-safety.js";
export {
  containsSecret,
  redactSecrets,
  secretLineRanges,
  SECRET_CONTENT_PATTERNS,
  SECRET_REDACTED,
} from "./secrets.js";
export { toFtsQuery, type SearchOptions } from "./search.js";
export {
  openKnowledge,
  registerPurgeHook,
  type CreateProjectInput,
  type IndexedDocument,
  type Knowledge,
  type OpenKnowledgeOptions,
} from "./knowledge.js";
export { KNOWLEDGE_MIGRATIONS } from "./schema.js";
export {
  NewEntrySchema,
  SourceRefSchema,
  Validity,
  type AddEntryInput,
  type Decision,
  type DecisionStatus,
  type KnowledgeEntry,
  type NewEntry,
  type Project,
  type RecordDecisionInput,
  type RecordEvidenceInput,
  type SearchHit,
  type SourceRef,
  type TaskEvidence,
  type ErasedTaskEvidence,
  type PurgeOptions,
} from "./types.js";
export {
  assertUtf8Capped,
  utf8Capped,
  emptyGuidance,
  fitGuidance,
  GUIDANCE_CAP_BYTES,
  MAX_PROJECT_NOTES_BYTES,
  MAX_REQUEST_NOTES_BYTES,
  MAX_SKILL_BYTES,
  openGuidance,
  renderGuidance,
  sha256Text,
  SKILL_FILE,
  skillFrontmatter,
  type Guidance,
  type GuidanceSkill,
  type GuidanceSnapshot,
  type ProjectGuidance,
  type Skill,
  type SkillImportResult,
  type SkillListing,
  type SkillSkipReason,
} from "./guidance.js";
