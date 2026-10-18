export const PACKAGE_NAME = "@sindri/delivery";

export {
  DeliveryLoop,
  EXECUTION_STATUSES,
  type ArtifactRef,
  type DeliveryLogger,
  type DeliveryLoopOptions,
  type DeliveryNotice,
  type VerificationFailureHandler,
  type Execution,
  type EscalationDecision,
  type ExecutionApproval,
  type ExecutionEventRow,
  type ExecutionStatus,
  type ExecutionTask,
  type InboxItem,
  type PermissionPolicy,
  type ResolveEscalationInput,
  type RunResult,
} from "./delivery-loop.js";
export { DELIVERY_MIGRATIONS } from "./migrations.js";

// S6: quality gates, independent review, delivery report, knowledge update, traceability.
export {
  BROKKR_CHECK_STATES,
  BROKKR_REPORT_KIND,
  BROKKR_VERDICTS,
  ENGINEERING_GATE_ID,
  evaluateEngineering,
  parseVerificationReport,
  sameCommit,
  VerificationReportSchema,
  type BrokkrCheckResult,
  type BrokkrVerdict,
  type GateFailure,
  type VerificationReport,
} from "./gates/brokkr-report.js";
export {
  contextReaderFrom,
  executionReaderFor,
  mimirActionsFor,
  mimirArtifactContentReader,
} from "./gates/binding.js";
export {
  DEFAULT_TRUSTED_SOURCES,
  evidenceTrust,
  isTrusted,
  manifestHead,
  manifestOfVerifyingStep,
  readVerifiedArtifact,
  recordedArtifacts,
  sha256Hex,
  testRuns,
  type EvidenceTrust,
  type RecordedArtifact,
  type TestRun,
} from "./gates/evidence.js";
export {
  GateError,
  GateRunner,
  repairInstruction,
  type EnforceAction,
  type EnforceOutcome,
  type GateResult,
  type GateRunnerOptions,
  type GateSpec,
  type ReviewVerdictSource,
  type ReviewVerdictView,
} from "./gates/gate-runner.js";
export { QUALITY_MIGRATIONS } from "./gates/migrations.js";
export { ensureDeliverySchema, ensureQualitySchema } from "./schema.js";
export type * from "./gates/ports.js";
export {
  REVIEW_ARTIFACT_KIND,
  REVIEW_FILE,
  ReviewFileSchema,
  ReviewOrchestrator,
  ReviewPolicyError,
  reviewInstruction,
  type ReviewDecision,
  type ReviewFile,
  type ReviewFinding,
  type ReviewOrchestratorOptions,
  type ReviewOrigin,
  type ReviewPolicyCode,
  type ReviewRecord,
  type ReviewRole,
  type RequestReviewOptions,
} from "./review/review-orchestrator.js";
export {
  CITATION,
  splitSentences,
  validateCitations,
  type CitationCheck,
  type CitedSentence,
  type StrippedSentence,
} from "./report/citations.js";
export {
  CHANGED_FILES_KIND,
  DeliveryError,
  DeliveryReports,
  renderPrDescription,
  SCREENSHOT_KIND_PREFIX,
  SUMMARY_PURPOSE,
  summarySystem,
  type DeliveryErrorCode,
  type DeliveryReport,
  type DeliveryReportsOptions,
  type DeliveryStatus,
  type PrDelivery,
  type RequirementStatus,
} from "./report/delivery-report.js";
export {
  evidenceCatalog,
  KnowledgeUpdateError,
  KnowledgeUpdater,
  type KnowledgeProposal,
  type KnowledgeUpdateErrorCode,
  type KnowledgeUpdaterOptions,
  type ProposalKind,
  type ProposalStatus,
} from "./knowledge-update/knowledge-updater.js";
export {
  DeliveryTracer,
  TraceError,
  type DeliveryTracerOptions,
  type TraceArtifact,
  type TraceDocument,
  type TraceEvent,
  type TraceReview,
} from "./trace/trace.js";
