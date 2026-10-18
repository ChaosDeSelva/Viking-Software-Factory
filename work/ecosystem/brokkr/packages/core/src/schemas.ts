import { posix } from "node:path";
import semver from "semver";
import { z } from "zod";

/** The only manifest API version understood by this release. */
export const API_VERSION = "brokkr.dev/v1alpha1";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Kebab-case identifier used for harness, skill and profile names (max 64 chars). */
export const NameSchema = z
  .string()
  .max(64, "must be at most 64 characters")
  .regex(KEBAB, "must be kebab-case (lowercase letters, digits, single hyphens)");

/** Exact semantic version, e.g. `1.2.3`. */
export const SemverSchema = z
  .string()
  .refine((v) => semver.valid(v) === v, "must be an exact semantic version such as 1.0.0");

/** Semver range, e.g. `^1.0.0`, `>=1.2 <2`. */
export const SemverRangeSchema = z
  .string()
  .min(1)
  .refine((v) => semver.validRange(v) !== null, "must be a valid semver range such as ^1.0.0");

/**
 * Relative path that cannot escape its base directory: not absolute, no
 * backslashes, no `..` segment after normalisation.
 */
export const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) => isSafeRelativePath(p),
    "must be a relative path that stays inside its base directory",
  );

export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.includes("\0") || p.includes("\\")) return false;
  // Absolute paths, drive letters and any URL scheme (javascript:, data:, http:) are rejected.
  if (posix.isAbsolute(p) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return false;
  const normalized = posix.normalize(p);
  return normalized !== ".." && !normalized.startsWith("../");
}

export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 digest of the form sha256:<64 hex chars>");

export const PlatformSchema = z.enum(["darwin", "linux", "win32"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const CheckIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lowercase letters, digits, '.', '_' or '-'");

export const EnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

export const CheckDefinitionSchema = z.strictObject({
  id: CheckIdSchema,
  /** argv array; executed without a shell. */
  command: z
    .array(z.string().min(1, "argv entries must be non-empty"))
    .min(1, "must contain at least the executable"),
  required: z.boolean(),
  timeoutSeconds: z.number().int().positive().max(86_400),
  cwd: RelativePathSchema.optional(),
  when: z
    .strictObject({
      /** Every listed file must exist (relative to the check cwd). */
      fileExists: z.array(RelativePathSchema).optional(),
      /** At least one listed file must exist (e.g. playwright.config.ts|js|mjs). */
      anyFileExists: z.array(RelativePathSchema).min(1).optional(),
      /** Every listed package.json script must exist. All `when` keys combine with AND. */
      scriptExists: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Extra environment variable names passed through to the check (secret-looking names never are). */
  env: z.array(EnvNameSchema).optional(),
  /** An approved exception (`policy: check:<id>`) may waive this check. */
  waivable: z.boolean().optional(),
  /** Consecutive checks with `parallel: true` run concurrently as one group. */
  parallel: z.boolean().optional(),
});
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

export const AllowDenySchema = z.enum(["allow", "deny"]);
export type AllowDeny = z.infer<typeof AllowDenySchema>;

export const PoliciesSchema = z.strictObject({
  network: AllowDenySchema,
  destructiveCommands: AllowDenySchema,
  requireApprovalFor: z.array(z.string().min(1)),
});
export type Policies = z.infer<typeof PoliciesSchema>;

export const EvidenceSchema = z.strictObject({
  captureLogs: z.boolean(),
  captureTestResults: z.boolean(),
  captureScreenshots: z.boolean(),
});
export type EvidenceRequirements = z.infer<typeof EvidenceSchema>;

export const HarnessDependencySchema = z.strictObject({
  name: NameSchema,
  version: SemverRangeSchema,
});
export type HarnessDependency = z.infer<typeof HarnessDependencySchema>;

export const HarnessManifestSchema = z
  .strictObject({
    apiVersion: z.literal(API_VERSION),
    kind: z.literal("Harness"),
    metadata: z.strictObject({
      name: NameSchema,
      version: SemverSchema,
      description: z.string().min(1),
    }),
    compatibility: z.strictObject({
      platforms: z.array(PlatformSchema).min(1),
      taskTypes: z.array(z.string().min(1)),
      brokkr: SemverRangeSchema.optional(),
    }),
    dependsOn: z.array(HarnessDependencySchema).optional(),
    conflictsWith: z.array(NameSchema).optional(),
    skills: z.strictObject({
      required: z.array(NameSchema),
      optional: z.array(NameSchema),
    }),
    workflow: z.strictObject({ stages: z.array(z.string().min(1)) }),
    checks: z.array(CheckDefinitionSchema),
    policies: PoliciesSchema,
    evidence: EvidenceSchema,
    aiReview: z.strictObject({ criteria: z.array(z.string().min(1)) }).optional(),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.checks.forEach((check, index) => {
      if (seen.has(check.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["checks", index, "id"],
          message: `duplicate check id '${check.id}'`,
        });
      }
      seen.add(check.id);
    });
    const required = new Set(manifest.skills.required);
    manifest.skills.optional.forEach((name, index) => {
      if (required.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["skills", "optional", index],
          message: `skill '${name}' is listed as both required and optional`,
        });
      }
    });
  });
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;

export const SkillManifestSchema = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("Skill"),
  metadata: z.strictObject({
    name: NameSchema,
    version: SemverSchema,
    description: z.string().min(1),
    tags: z.array(z.string().min(1)),
  }),
  dependsOn: z.array(NameSchema).optional(),
  conflictsWith: z.array(NameSchema).optional(),
  selectors: z.strictObject({
    taskTypes: z.array(z.string().min(1)).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    pathGlobs: z.array(z.string().min(1)).optional(),
  }),
  /** Markdown body, relative to the skill directory. */
  body: RelativePathSchema.refine((p) => p.endsWith(".md"), "must point to a Markdown (.md) file"),
  estimatedTokens: z.number().int().nonnegative(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const HarnessRequestSchema = z.strictObject({
  name: NameSchema,
  version: SemverRangeSchema,
});
export type HarnessRequest = z.infer<typeof HarnessRequestSchema>;

export const ProfileSchema = z.strictObject({
  name: NameSchema,
  harnesses: z.array(HarnessRequestSchema),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * One layer of policy configuration (spec §9.1). Layers are merged
 * system → organization → project → harness → task; lower layers may only
 * strengthen (see @brokkr/policy).
 */
export const PolicyLayerSchema = z.strictObject({
  network: AllowDenySchema.optional(),
  destructiveCommands: AllowDenySchema.optional(),
  /** Globs matched against argv[0]; when any layer sets a list, argv[0] must match every list. */
  allowedCommands: z.array(z.string().min(1)).optional(),
  /** Operations that need an approval record, e.g. `install-dependencies`. */
  requireApprovalFor: z.array(z.string().min(1)).optional(),
  /** Check ids that must exist and pass (minimum test requirements). */
  requiredCheckIds: z.array(CheckIdSchema).optional(),
  /** Require a review result (review requirements). */
  reviewRequired: z.boolean().optional(),
  /** Policy ids that an approved exception may waive, e.g. `check:visual`. */
  waivable: z.array(z.string().min(1)).optional(),
  /** Policy ids that must never be waived, regardless of lower layers. */
  nonWaivable: z.array(z.string().min(1)).optional(),
  /**
   * Check ids allowed to use the network even when a harness denies it.
   * Honoured only from organization and project layers (ADR-006).
   */
  allowNetworkFor: z.array(CheckIdSchema).optional(),
});
export type PolicyLayer = z.infer<typeof PolicyLayerSchema>;

export const TaskDescriptorSchema = z.strictObject({
  id: z
    .string()
    .max(128)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "must start with a letter or digit and contain only A-Z, a-z, 0-9, '.', '_', '-'",
    ),
  title: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  taskTypes: z.array(z.string().min(1)).optional(),
  context: z.record(z.string(), z.string()).optional(),
  /** Per-task policy overrides (may only strengthen). */
  policies: PolicyLayerSchema.optional(),
});
export type TaskDescriptor = z.infer<typeof TaskDescriptorSchema>;

export const HarnessLockSchema = z.strictObject({
  /** 2: exclusion lists removed (every file is always hashed). */
  lockVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  harnesses: z.array(
    z.strictObject({
      name: NameSchema,
      version: SemverSchema,
      digest: Sha256DigestSchema,
      source: z.string().min(1),
    }),
  ),
  skills: z.array(
    z.strictObject({
      name: NameSchema,
      version: SemverSchema,
      digest: Sha256DigestSchema,
    }),
  ),
  adapters: z.array(z.strictObject({ id: z.string().min(1), version: z.string().min(1) })),
  /**
   * The profile the selection was resolved with: its name and the digest of the
   * resolved profile (harness requests, overrides and policies). Covered by `digest`.
   */
  profile: z.strictObject({ name: NameSchema, digest: Sha256DigestSchema }).optional(),
  digest: Sha256DigestSchema,
});
export type HarnessLock = z.infer<typeof HarnessLockSchema>;

export const ExternalSourceSchema = z.union([
  z.strictObject({ path: z.string().min(1), digest: Sha256DigestSchema, trusted: z.boolean() }),
  z.strictObject({ tarball: z.string().min(1), digest: Sha256DigestSchema, trusted: z.boolean() }),
]);
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;

/** `.brokkr/config.yaml` */
export const ProjectConfigSchema = z.strictObject({
  version: z.literal(1),
  /** Project id used to scope approval exceptions. */
  project: z.string().min(1).optional(),
  harnesses: z.array(HarnessRequestSchema),
  profiles: z.array(ProfileSchema).optional(),
  sources: z.array(ExternalSourceSchema).optional(),
  /** Project policy layer. */
  policies: PolicyLayerSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CHECK_STATES = [
  "passed",
  "failed",
  "errored",
  "skipped",
  "cancelled",
  "timed_out",
] as const;
export const CheckStateSchema = z.enum(CHECK_STATES);
export type CheckState = z.infer<typeof CheckStateSchema>;

export const VERDICTS = ["passed", "failed", "incomplete", "blocked"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Version of the Brokkr manifest/runtime implementation, used for `compatibility.brokkr`. */
export const BROKKR_VERSION = "0.1.0";

/** `roles/<name>.yaml` inside a harness package. */
export const RoleSchema = z.strictObject({
  name: NameSchema,
  description: z.string().min(1).optional(),
  /** Kind of agent expected to take the role (free-form, e.g. `coding-agent`, `reviewer`). */
  agentKind: z.string().min(1).optional(),
  /** Preferred model; advisory only. */
  model: z.string().min(1).optional(),
  skills: z.array(NameSchema),
  responsibilities: z.array(z.string().min(1)).min(1),
});
export type Role = z.infer<typeof RoleSchema>;

/** Placeholders allowed in `templates/brief.md`. */
export const TEMPLATE_PLACEHOLDERS = [
  "objective",
  "acceptanceCriteria",
  "context",
  "constraints",
] as const;
