export const PACKAGE_NAME = "@mimir/core";
export * from "./policy/index.js";
export * from "./domain/index.js";

export {
  SENSITIVE_KEY_PATTERN,
  isSensitiveKey,
  normaliseKey,
  findCredentialShapes,
  type CredentialShape,
  redact,
  redactPayload,
  type PayloadRedactor,
  type RedactionResult,
} from "./redaction.js";
export {
  SENSITIVE_HOME_ENTRIES,
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  sensitivePathPatterns,
  type SensitivePathOptions,
} from "./sensitive-paths.js";
export { MAX_JSON_DEPTH, assertJsonDepth, jsonDepth } from "./json-depth.js";
export { openDatabase, type Db, type Stmt } from "./store/db.js";
export { listMigrations, migrate, type Migration } from "./store/migrate.js";
export {
  DEFAULT_LOCK_STALE_MS,
  acquireLock,
  type FileLock,
  type LockOptions,
} from "./store/lock.js";
export {
  DEFAULT_MAX_PAYLOAD_BYTES,
  MIN_MAX_PAYLOAD_BYTES,
  EventStore,
  boundPayload,
  decodeCursor,
  encodeCursor,
  openEventStore,
  type AppendInput,
  type EventListener,
  type EventStoreOptions,
  type CorruptRowInfo,
  type StoreIntegrity,
  type StreamReadResult,
  type ReadOptions,
  type ReadResult,
  type TruncatedPayload,
} from "./store/event-store.js";
export {
  CommandLedger,
  hashRequest,
  type BeginResult,
  type CommandRecord,
} from "./store/command-ledger.js";
export { AuditLog, type AuditInput, type AuditRecord } from "./store/audit-log.js";
