import { z } from "zod";
import {
  CheckIdSchema,
  CheckStateSchema,
  RelativePathSchema,
  Sha256DigestSchema,
  VerdictSchema,
} from "./schemas.js";

/** Report schema version (spec §10.2). */
export const REPORT_SCHEMA_VERSION = "1.0";

/** Why a check did not produce a pass/fail result. */
export const CHECK_REASONS = [
  "missing_tool",
  "missing_script",
  "condition_not_met",
  "policy_denied",
  "untrusted_source",
  "exception",
  "not_run",
  "timeout",
  "cancelled",
  "spawn_error",
  "cwd_rejected",
  "network_denied",
  "invalid_command",
  "orphaned_descendants",
  "not_applicable",
] as const;
export const CheckReasonSchema = z.enum(CHECK_REASONS);
export type CheckReason = z.infer<typeof CheckReasonSchema>;

export const CheckResultSchema = z.strictObject({
  id: CheckIdSchema,
  required: z.boolean(),
  /** `policy` when a `requiredCheckIds` policy (not only the harness) requires the check. */
  requiredBy: z.enum(["harness", "policy"]).optional(),
  state: CheckStateSchema,
  command: z.array(z.string()),
  /** Working directory relative to the workspace. */
  cwd: z.string(),
  /** `name@version` of each harness that declared the check. */
  from: z.array(z.string()),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  durationMs: z.number().nonnegative(),
  reason: CheckReasonSchema.optional(),
  /** Human-readable diagnostic (why skipped/errored, how to fix). */
  message: z.string().optional(),
  exceptionId: z.string().optional(),
  log: RelativePathSchema.optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  maxRssBytes: z.number().int().nonnegative().optional(),
  secretFindings: z.number().int().nonnegative().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const POLICY_LAYERS = ["system", "organization", "project", "harness", "task"] as const;
export const PolicyLayerNameSchema = z.enum(POLICY_LAYERS);
export type PolicyLayerName = z.infer<typeof PolicyLayerNameSchema>;

export const PolicyDecisionSchema = z.strictObject({
  policy: z.string().min(1),
  stage: z.enum(["before", "runtime", "after"]),
  outcome: z.enum(["allow", "deny", "require_approval", "approved", "waived", "unmet", "warn"]),
  layer: PolicyLayerNameSchema,
  checkId: z.string().optional(),
  exceptionId: z.string().optional(),
  message: z.string(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

const IsoDate = z.iso.datetime({ offset: true });

const exceptionShape = {
  id: z.string().min(1),
  /** Policy id being waived, e.g. `check:visual` or `install-dependencies`. */
  policy: z.string().min(1),
  scope: z.strictObject({
    project: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    /** Binds an approval (e.g. `network-access`) to one check. */
    checkId: z.string().min(1).optional(),
  }),
  reason: z.string().min(1),
  approvedBy: z.string().min(1),
  approvedAt: IsoDate,
  expiresAt: IsoDate,
  evidence: z.array(z.string().min(1)),
};

export const ApprovedExceptionSchema = z
  .strictObject(exceptionShape)
  .refine((e) => Date.parse(e.expiresAt) > Date.parse(e.approvedAt), {
    message: "expiresAt must be after approvedAt",
    path: ["expiresAt"],
  });
export type ApprovedException = z.infer<typeof ApprovedExceptionSchema>;

/** `.brokkr/exceptions.yaml` */
export const ExceptionsFileSchema = z.strictObject({
  exceptions: z.array(ApprovedExceptionSchema),
});
export type ExceptionsFile = z.infer<typeof ExceptionsFileSchema>;

/** An exception as recorded in a report: tied to the exact task and harness versions. */
export const AppliedExceptionSchema = z.strictObject({
  ...exceptionShape,
  /** Where the exception came from; `workspace_supplied` = read from the workspace being verified. */
  origin: z.enum(["workspace_supplied", "external"]).optional(),
  appliedTo: z.strictObject({
    task: z.string().optional(),
    harnesses: z.array(z.string()),
    checkId: z.string().optional(),
  }),
});
export type AppliedException = z.infer<typeof AppliedExceptionSchema>;

/** Where a policy input (exceptions, project or organization policy) was loaded from. */
export const PolicySourceSchema = z.strictObject({
  kind: z.enum(["exceptions", "project-policy", "organization-policy"]),
  /** Workspace-relative when inside the workspace, otherwise absolute. */
  path: z.string().min(1),
  /** `workspace_supplied`: inside the workspace being verified, so writable by the agent under test. */
  origin: z.enum(["workspace_supplied", "external"]),
  digest: Sha256DigestSchema,
});
export type PolicySource = z.infer<typeof PolicySourceSchema>;

export const EvidenceKindSchema = z.enum(["log", "report", "test-result", "screenshot", "other"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceReferenceSchema = z.strictObject({
  /** Path relative to the run directory. */
  path: RelativePathSchema,
  sha256: Sha256DigestSchema,
  bytes: z.number().int().nonnegative(),
  /** Check id, or `brokkr` for files Brokkr itself writes. */
  producedBy: z.string().min(1),
  kind: EvidenceKindSchema,
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const VerificationReportSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  id: z.string().min(1),
  executionId: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  harness: z.strictObject({
    name: z.string(),
    version: z.string(),
    lockDigest: z.string(),
  }),
  /** Every harness in the composed set (the `harness` field summarises them). */
  harnesses: z.array(z.strictObject({ name: z.string(), version: z.string(), digest: z.string() })),
  repository: z.strictObject({
    commitSha: z.string().min(1),
    workspaceId: z.string().optional(),
    dirtyTreeDigest: Sha256DigestSchema.optional(),
  }),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  verdict: VerdictSchema,
  /** Why the verdict is what it is. */
  reasons: z.array(z.string()),
  /**
   * `developer`: the contract (config, lock, exceptions, policy) may come from the
   * workspace. `workspace-untrusted`: it came only from the caller (ADR-003).
   */
  trustMode: z.enum(["developer", "workspace-untrusted"]).optional(),
  /** True when the run was interrupted (Ctrl-C / abort). */
  interrupted: z.boolean().optional(),
  checks: z.array(CheckResultSchema),
  policyDecisions: z.array(PolicyDecisionSchema),
  exceptions: z.array(AppliedExceptionSchema),
  policySources: z.array(PolicySourceSchema).optional(),
  evidence: z.array(EvidenceReferenceSchema),
  summary: z.strictObject({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    /** errored + timed_out + cancelled. */
    errored: z.number().int().nonnegative(),
  }),
  environment: z.strictObject({
    brokkrVersion: z.string(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  warnings: z.array(z.string()),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

/** The §10.2 summary counters; timed-out and cancelled checks count as errored. */
export function summarizeChecks(checks: readonly CheckResult[]): VerificationReport["summary"] {
  const summary = { passed: 0, failed: 0, skipped: 0, errored: 0 };
  for (const c of checks) {
    if (c.state === "passed") summary.passed++;
    else if (c.state === "failed") summary.failed++;
    else if (c.state === "skipped") summary.skipped++;
    else summary.errored++;
  }
  return summary;
}
