export {
  Registry,
  type RegistryDiagnostic,
  type RegistryOptions,
  type SourceSummary,
} from "./registry.js";
export {
  CONFIG_FILE,
  ensureBrokkrDir,
  LOCK_FILE,
  loadProjectConfig,
  readLock,
  saveProjectConfig,
} from "./config.js";
export {
  validateHarnessDir,
  templatePlaceholderIssues,
  discoverHarnessDirs,
  type HarnessValidation,
  type HarnessPackage,
} from "./load.js";
export {
  resolveHarnessSet,
  SOURCE_PRECEDENCE,
  type ResolveRequest,
  type ResolveOptions,
} from "./resolve.js";
export { composeHarnessSet } from "./compose.js";
export {
  createLock,
  lockContentDigest,
  verifyLockAgainst,
  type AdapterRef,
  type LockEntryStatus,
  type LockVerification,
  type LockVerificationEntry,
} from "./lock.js";
export { inspectTarball, extractTarball, type TarballInspection } from "./tarball.js";
