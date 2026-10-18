import { z } from "zod";

/**
 * Sindri's view of the Brokkr SDK (`@brokkr/sdk`, brief B3 §12.2). These types mirror
 * `resolve({ task, profile? | harnesses? }) -> Selection`, `listHarnesses()` and
 * `inspectRepo()`; they are defined here because the SDK tarball is not available yet.
 * Brokkr owns harness content, selection and skill routing; Sindri only consumes results.
 */

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex chars>");

/** Brokkr `TaskDescriptor`. */
export const TaskDescriptorSchema = z.object({
  id: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  taskTypes: z.array(z.string().min(1)).optional(),
  context: z.record(z.string(), z.string()).optional(),
});
export type TaskDescriptor = z.infer<typeof TaskDescriptorSchema>;

/** `{ name, version }` where `version` is a semver range. */
export interface HarnessRequest {
  name: string;
  version: string;
}

/** Exactly one of `profile` or `harnesses` may be given; neither means "let Brokkr choose". */
export type ResolveInput =
  | { task: TaskDescriptor; profile?: string; harnesses?: never }
  | { task: TaskDescriptor; harnesses?: HarnessRequest[]; profile?: never };

export const SelectedHarnessSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  digest: Digest,
  description: z.string(),
  taskTypes: z.array(z.string()),
  checks: z.array(z.object({ id: z.string().min(1), required: z.boolean() })),
});
export type SelectedHarness = z.infer<typeof SelectedHarnessSchema>;

export const SelectedSkillSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  reason: z.string(),
  requiredBy: z.string().optional(),
  score: z.number(),
});
export type SelectedSkill = z.infer<typeof SelectedSkillSchema>;

const LockEntry = z.object({ name: z.string().min(1), version: z.string().min(1), digest: Digest }).passthrough();
export const HarnessLockSchema = z.object({
  digest: Digest,
  harnesses: z.array(LockEntry),
  skills: z.array(LockEntry),
}).passthrough();
export type HarnessLock = z.infer<typeof HarnessLockSchema>;

export const RationaleEntrySchema = z.object({
  kind: z.enum(["harness", "skill"]),
  name: z.string().min(1),
  selected: z.boolean(),
  reason: z.string(),
  score: z.number().optional(),
});
export type RationaleEntry = z.infer<typeof RationaleEntrySchema>;

/** Brokkr `Selection { harnesses, skills, lock, rationale }`. */
export const SelectionSchema = z.object({
  harnesses: z.array(SelectedHarnessSchema),
  skills: z.array(SelectedSkillSchema),
  lock: HarnessLockSchema,
  rationale: z.array(RationaleEntrySchema),
});
export type Selection = z.infer<typeof SelectionSchema>;

export interface HarnessSummary {
  name: string;
  version: string;
  description: string;
  taskTypes: string[];
  skills: { required: string[]; optional: string[] };
  checks: { id: string; required: boolean }[];
}

/** Brokkr `RepoSignals`. */
export interface RepoSignals {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "gradle" | null;
  frameworks: string[];
  scripts: string[];
  hasTsconfig: boolean;
  testRunners: string[];
}

/** The only harness surface Sindri depends on. */
export interface HarnessService {
  resolve(input: ResolveInput): Promise<Selection>;
  listHarnesses(): Promise<HarnessSummary[]>;
  inspectRepo(): Promise<RepoSignals>;
}

export type HarnessServiceErrorCode = "not_found" | "no_match" | "invalid_request" | "not_wired";

export class HarnessServiceError extends Error {
  override readonly name = "HarnessServiceError";
  constructor(
    readonly code: HarnessServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
