export const PACKAGE_NAME = "@mimir/git";

export {
  GitManager,
  OWNER_FILE,
  DEFAULT_WORKTREE_ROOT,
  defaultWorktreeRoot,
  SCRATCH_DIR,
  OwnerClaimSchema,
  type DiffOptions,
  type RestoreResult,
  type RestoreRecord,
  type GitManagerOptions,
  type RegisterProjectInput,
  type CreateWorktreeInput,
  type OwnerClaim,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  type FileChangeStatus,
  type DiffFile,
  type WorktreeDiff,
  type ChangedFilesManifest,
  type CommitInfo,
  type ConflictReport,
} from "./manager.js";
export {
  protectedBranchGuard,
  type ProtectedBranchGuard,
  type ProtectedBranchRules,
} from "./protected.js";
export {
  runTests,
  scrubbedEnv,
  OUTPUT_CAP_BYTES,
  DEFAULT_TEST_TIMEOUT_MS,
  ENV_ALLOWLIST,
  type RunTestsOptions,
  type RunTestsResult,
} from "./run-tests.js";
export {
  assertSafeAbsolutePath,
  assertSlug,
  branchNameFor,
  isInside,
  assertNoSymlinkBelow,
  MAX_SLUG_LENGTH,
} from "./paths.js";
export { auditRepoConfig, gitEnv, GIT_ENV_ALLOWLIST, SAFE_CONFIG } from "./git.js";
