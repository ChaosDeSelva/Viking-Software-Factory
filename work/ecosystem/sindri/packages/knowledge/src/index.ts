export const PACKAGE_NAME = "@sindri/knowledge";

export { isSindriError, SindriError, SINDRI_ERROR_STATUS, type SindriErrorCode } from "./errors.js";
export { applyMigrations, openDatabase, type SqliteDatabase } from "./db.js";
export { chunkText, DEFAULT_CHUNK_SIZE, type TextChunk } from "./chunk.js";
export {
  classify,
  isSecretPath,
  isUnsafeName,
  auditGitConfig,
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
