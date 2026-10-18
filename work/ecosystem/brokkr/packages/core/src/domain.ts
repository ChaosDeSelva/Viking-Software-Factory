import type {
  CheckDefinition,
  EvidenceRequirements,
  HarnessManifest,
  Policies,
  SkillManifest,
  TaskDescriptor,
} from "./schemas.js";

/** Where a harness package was discovered (spec §5.1). */
export type SourceKind = "builtin" | "user" | "project" | "external";
export type TrustLevel = "trusted" | "untrusted";

/** A skill package loaded from disk inside a harness package. */
export interface LoadedSkill {
  manifest: SkillManifest;
  /** Absolute skill directory. */
  dir: string;
  /** Absolute path of the Markdown body. */
  bodyPath: string;
  /** Tree digest of the skill directory. */
  digest: string;
  /** `name@version` of the harness package that ships this skill. */
  providedBy: string;
}

/** A harness package loaded from one registry source. */
export interface LoadedHarness {
  manifest: HarnessManifest;
  /** Absolute harness directory. */
  dir: string;
  /** Tree digest of the harness directory (includes its skills). */
  digest: string;
  source: SourceKind;
  /** Stable, machine-independent description of the source, e.g. `builtin` or `external:vendor/h.tgz`. */
  sourceRef: string;
  trust: TrustLevel;
  skills: LoadedSkill[];
}

export interface ResolvedHarness extends LoadedHarness {
  /** False for untrusted sources: checks may be listed but must not run (enforced by the runner). */
  executionAllowed: boolean;
  /** Who pulled this harness in: `request` for top-level requests or `name@version` of a dependent. */
  requestedBy: string[];
}

/** Output of `Registry.resolve`: the dependency closure in deterministic (topological, then name) order. */
export interface ResolvedHarnessSet {
  harnesses: ResolvedHarness[];
  /** All skills shipped by the resolved harnesses, keyed by skill name. */
  skills: Record<string, LoadedSkill>;
}

export interface ComposedCheck extends CheckDefinition {
  /** `name@version` of each harness that declared this check id. */
  from: string[];
}

/** Merged view of a resolved harness set (`compose`). */
export interface ComposedHarness {
  harnesses: Array<{ name: string; version: string }>;
  checks: ComposedCheck[];
  policies: Policies;
  skills: { required: string[]; optional: string[] };
  /** Skill name → `name@version` of each harness that lists it as required. */
  requiredBy: Record<string, string[]>;
  workflow: { stages: string[] };
  evidence: EvidenceRequirements;
  aiReview: { criteria: string[] };
  executionAllowed: boolean;
  warnings: string[];
}

/** One selected skill (spec §6.3). */
export interface ResolvedSkill {
  name: string;
  version: string;
  selected: true;
  reason: string;
  requiredBy?: string;
  score: number;
}

export interface SkillRejection {
  name: string;
  reason: string;
  score?: number;
}

export interface RepoSignals {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "gradle" | null;
  frameworks: string[];
  scripts: string[];
  hasTsconfig: boolean;
  testRunners: string[];
}

/** Context handed to provider adapters. */
export interface AdapterContext {
  /** Absolute repository root. */
  cwd: string;
  task: TaskDescriptor;
  composed: ComposedHarness;
  /** Skill catalog to read bodies/descriptions from (normally `ResolvedHarnessSet.skills`). */
  skillCatalog: Record<string, LoadedSkill>;
  /** Only when true may an adapter write into the project's own instruction files. */
  modifyProjectInstructions?: boolean;
}

export interface CompatibilityResult {
  compatible: boolean;
  issues: string[];
  warnings: string[];
}

export interface PreparedFile {
  /** Absolute path. */
  path: string;
  /** POSIX path relative to `AdapterContext.cwd`. */
  relativePath: string;
  digest: string;
  bytes: number;
  /** `created`: whole file owned by Brokkr; `block`: a marked block inside a project file. */
  mode: "created" | "block";
}

export interface PreparedContext {
  adapterId: string;
  adapterVersion: string;
  /** Absolute isolated bundle directory. */
  rootDir: string;
  /** Absolute path of the main instruction file the agent should read. */
  entrypoint: string;
  files: PreparedFile[];
  /** Absolute path of the ledger `cleanup` uses to remove exactly these files. */
  ledgerPath: string;
}

/** Provider adapter interface (spec §7.2). */
export interface ProviderAdapter {
  id: string;
  version: string;
  validateEnvironment(ctx: AdapterContext): Promise<CompatibilityResult>;
  prepare(skills: ResolvedSkill[], ctx: AdapterContext): Promise<PreparedContext>;
  cleanup(ctx: AdapterContext): Promise<void>;
}

/** Default isolated bundle directory for a task and adapter. */
export const GENERATED_CONTEXT_DIR = ".brokkr/generated/task-context";
