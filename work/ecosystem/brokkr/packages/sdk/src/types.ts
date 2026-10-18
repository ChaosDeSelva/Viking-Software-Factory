import { z } from "zod";
import {
  HarnessLockSchema,
  NameSchema,
  SemverRangeSchema,
  SemverSchema,
  Sha256DigestSchema,
  TaskDescriptorSchema,
  type HarnessLock,
  type RepoSignals,
  type SourceKind,
  type TaskDescriptor,
  type TrustLevel,
} from "@brokkr/core";

/** Version of the `Selection` contract. Bumped only on breaking changes. */
export const SELECTION_SCHEMA_VERSION = 1 as const;

/** Provider adapters the SDK can prepare context for. */
export const PROVIDERS = ["claude-code", "codex", "generic"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** A harness request: `version` is a semver range. */
export interface HarnessRequest {
  name: string;
  version: string;
}

/**
 * Input of {@link Brokkr.resolve}. Give a `profile` or explicit `harnesses`,
 * never both. With neither, Brokkr uses `.brokkr/config.yaml` and otherwise
 * chooses harnesses from the task's types and tags, then from repository signals.
 */
export type ResolveInput = {
  task: TaskDescriptor;
  /** Maximum total `estimatedTokens` of selected skills; optional skills are dropped to fit. */
  budgetTokens?: number;
} & (
  | { profile: string; harnesses?: never }
  | { harnesses: HarnessRequest[]; profile?: never }
  | { profile?: never; harnesses?: never }
);

export interface SelectedCheck {
  id: string;
  required: boolean;
}

export interface SelectedHarness {
  name: string;
  version: string;
  /** Tree digest of the harness package (`sha256:<hex>`). */
  digest: string;
  description: string;
  taskTypes: string[];
  source: SourceKind;
  sourceRef: string;
  trust: TrustLevel;
  executionAllowed: boolean;
  checks: SelectedCheck[];
}

export interface SelectedSkill {
  name: string;
  version: string;
  digest: string;
  reason: string;
  requiredBy?: string;
  score: number;
}

export interface RationaleEntry {
  kind: "harness" | "skill";
  name: string;
  selected: boolean;
  reason: string;
  score?: number;
}

/**
 * Result of {@link Brokkr.resolve}: a plain, JSON-serializable value that can be
 * stored or sent to another process and later passed to `prepare` or `verify`.
 * Its `lock` pins every harness and skill digest; `prepare` refuses and
 * `verify` blocks when the installed content no longer matches.
 */
export interface Selection {
  schemaVersion: typeof SELECTION_SCHEMA_VERSION;
  task: TaskDescriptor;
  profile?: string;
  harnesses: SelectedHarness[];
  skills: SelectedSkill[];
  lock: HarnessLock;
  rationale: RationaleEntry[];
  warnings: string[];
}

export interface HarnessSummary {
  name: string;
  version: string;
  description: string;
  taskTypes: string[];
  source: SourceKind;
  sourceRef: string;
  trust: TrustLevel;
  digest: string;
  skills: { required: string[]; optional: string[] };
  checks: SelectedCheck[];
}

export type { RepoSignals, TaskDescriptor };

/** Minimal structured logger (pino-compatible). */
export interface BrokkrLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const CheckSchema = z.strictObject({ id: z.string().min(1), required: z.boolean() });

/** Runtime validation for selections coming back from storage or another process. */
export const SelectionSchema = z.strictObject({
  schemaVersion: z.literal(SELECTION_SCHEMA_VERSION),
  task: TaskDescriptorSchema,
  profile: NameSchema.optional(),
  harnesses: z
    .array(
      z.strictObject({
        name: NameSchema,
        version: SemverSchema,
        digest: Sha256DigestSchema,
        description: z.string(),
        taskTypes: z.array(z.string()),
        source: z.enum(["builtin", "user", "project", "external"]),
        sourceRef: z.string().min(1),
        trust: z.enum(["trusted", "untrusted"]),
        executionAllowed: z.boolean(),
        checks: z.array(CheckSchema),
      }),
    )
    .min(1),
  skills: z.array(
    z.strictObject({
      name: NameSchema,
      version: SemverSchema,
      digest: Sha256DigestSchema,
      reason: z.string(),
      requiredBy: z.string().optional(),
      score: z.number(),
    }),
  ),
  lock: HarnessLockSchema,
  rationale: z.array(
    z.strictObject({
      kind: z.enum(["harness", "skill"]),
      name: z.string().min(1),
      selected: z.boolean(),
      reason: z.string(),
      score: z.number().optional(),
    }),
  ),
  warnings: z.array(z.string()),
});

export const HarnessRequestInputSchema = z.strictObject({
  name: NameSchema,
  version: SemverRangeSchema,
});
