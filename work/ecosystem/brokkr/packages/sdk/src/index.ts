/**
 * `@brokkr/sdk`: the public integration interface of Brokkr (spec §12).
 *
 * @packageDocumentation
 */
export {
  Brokkr,
  TRUST_MODES,
  type BrokkrOptions,
  type TrustMode,
  type CleanupInput,
  type PrepareInput,
  type VerifyInput,
} from "./brokkr.js";
export {
  PROVIDERS,
  SELECTION_SCHEMA_VERSION,
  SelectionSchema,
  type BrokkrLogger,
  type HarnessRequest,
  type HarnessSummary,
  type ProviderId,
  type RationaleEntry,
  type RepoSignals,
  type ResolveInput,
  type SelectedCheck,
  type SelectedHarness,
  type SelectedSkill,
  type Selection,
  type TaskDescriptor,
} from "./types.js";
export {
  EVENT_SCHEMA_VERSION,
  VERIFICATION_EVENT_TYPES,
  VerificationEventSchema,
  type CheckCompletedEvent,
  type CheckStartedEvent,
  type EventEnvelope,
  type VerificationCancelledEvent,
  type VerificationCompletedEvent,
  type VerificationEvent,
  type VerificationEventType,
  type VerificationFailedEvent,
  type VerificationStartedEvent,
} from "./events.js";
export {
  BrokkrError,
  CHECK_REASONS,
  type ApprovedException,
  type PolicyLayer,
  type Profile,
  EXIT_CODES,
  REPORT_SCHEMA_VERSION,
  VerificationReportSchema,
  exitCodeForVerdict,
  type AppliedException,
  type BrokkrErrorCode,
  type CheckReason,
  type CheckResult,
  type CheckState,
  type EvidenceReference,
  type ExitCode,
  type HarnessLock,
  type PolicyDecision,
  type PreparedContext,
  type PreparedFile,
  type Verdict,
  type VerificationReport,
} from "@brokkr/core";
export {
  LocalProcessExecutor,
  type CheckExecutionRequest,
  type CheckExecutionResult,
  type CheckExecutor,
  type ExecutionState,
} from "@brokkr/runner";
export { type IntegrityResult, type StoredReport } from "@brokkr/evidence";
export { REPORT_FORMATS, renderReport, type ReportFormat } from "@brokkr/reporters";
export {
  selectionJsonSchema,
  verificationEventJsonSchema,
  verificationReportJsonSchema,
} from "./schemas.js";
