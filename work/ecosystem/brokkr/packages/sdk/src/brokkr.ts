import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import semver from "semver";
import type { z } from "zod";
import {
  ApprovedExceptionSchema,
  BrokkrError,
  canonicalJson,
  sha256Digest,
  HarnessLockSchema,
  PolicyLayerSchema,
  ProfileSchema,
  TaskDescriptorSchema,
  formatIssues,
  parseManifestText,
  validateWith,
  type AdapterContext,
  type ApprovedException,
  type HarnessLock,
  type PolicyLayer,
  type HarnessManifest,
  type LoadedHarness,
  type PreparedContext,
  type Profile,
  type ProjectConfig,
  type ProviderAdapter,
  type RepoSignals,
  type ResolvedHarnessSet,
  type ResolvedSkill,
  type TaskDescriptor,
  type VerificationReport,
} from "@brokkr/core";
import { readReport as readStoredReport, type StoredReport } from "@brokkr/evidence";
import { loadExceptions, loadOrgPolicy, type PolicyLayerInput } from "@brokkr/policy";
import {
  readGeneratedBundles,
  runVerification,
  type CheckExecutor,
  type VerifyEvent,
} from "@brokkr/runner";
import { createClaudeCodeAdapter } from "@brokkr/adapter-claude-code";
import { createCodexAdapter } from "@brokkr/adapter-codex";
import { createGenericAdapter } from "@brokkr/adapter-generic";
import {
  Registry,
  createLock,
  loadProjectConfig,
  lockContentDigest,
  type AdapterRef,
} from "@brokkr/registry";
import { inspectRepo, recommendHarnesses, resolveSkills } from "@brokkr/resolver";
import { defaultBuiltinDir } from "./builtin.js";
import { createEventSink, type VerificationEvent } from "./events.js";
import {
  HarnessRequestInputSchema,
  PROVIDERS,
  SELECTION_SCHEMA_VERSION,
  SelectionSchema,
  type BrokkrLogger,
  type HarnessRequest,
  type HarnessSummary,
  type ProviderId,
  type RationaleEntry,
  type ResolveInput,
  type SelectedHarness,
  type Selection,
} from "./types.js";

const ADAPTERS: Record<ProviderId, () => ProviderAdapter> = {
  "claude-code": createClaudeCodeAdapter,
  codex: createCodexAdapter,
  generic: createGenericAdapter,
};

const SILENT: BrokkrLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Who defines the verification contract.
 *
 * - `workspace-untrusted` (default): the repository is not trusted to decide
 *   what "verified" means. Harnesses, profiles, lock, policy and exceptions come
 *   only from the constructor inputs, the built-in library and the user's own
 *   `~/.brokkr` (user harnesses, organization policy). Nothing under `cwd/.brokkr`
 *   or the workspace's `.brokkr` is read.
 * - `developer`: a trusted developer on their own repository; `.brokkr/config.yaml`,
 *   project-local harnesses, profiles, policy and `.brokkr/exceptions.yaml` under
 *   `cwd` are read as well.
 */
export type TrustMode = "workspace-untrusted" | "developer";
export const TRUST_MODES: readonly TrustMode[] = ["workspace-untrusted", "developer"];

export interface BrokkrOptions {
  /**
   * Repository root: repository signals are inspected here and, only in
   * `developer` mode, `.brokkr/` configuration is read from here. A verified
   * workspace's own `.brokkr/` is never read.
   */
  cwd: string;
  /** Default `workspace-untrusted`. */
  trust?: TrustMode;
  /** Default contract for `resolve` when it is given neither a profile nor harnesses. */
  harnesses?: HarnessRequest[];
  /** Caller-defined profiles (names must not shadow built-in profiles). */
  profiles?: Profile[];
  /**
   * Pinned lock (for example the one recorded when the work was planned).
   * `verify` blocks with `lock_integrity` when the selection's lock differs.
   */
  lock?: HarnessLock;
  /** Approval exceptions from the caller's approval store; the only exceptions in `workspace-untrusted` mode. */
  exceptions?: ApprovedException[];
  /** Project-layer policy supplied by the caller. Lower layers can only strengthen it. */
  policy?: PolicyLayer;
  /**
   * Brokkr 0.1 performs no network access at all; `offline` is accepted for
   * forward compatibility and makes that guarantee explicit.
   */
  offline?: boolean;
  /** Logger for registry diagnostics and warnings. Silent by default. */
  logger?: BrokkrLogger;
  /** Built-in harness library. Defaults to the library shipped with the SDK. */
  builtinDir?: string;
  /**
   * Home directory for user harnesses, organization policy, the runs store
   * (`<home>/.brokkr/runs/`) and the evidence signing key (`<home>/.brokkr/key`).
   * Defaults to `os.homedir()`.
   */
  homeDir?: string;
  /**
   * Approver identities whose exceptions are honoured. In `workspace-untrusted`
   * mode an exception applies only when its `approvedBy` is listed here (ADR-006).
   */
  approvers?: string[];
  /** Directory receiving `run_<ulid>/` (default `<homeDir>/.brokkr/runs/<sha256(workspace)>`). */
  runRoot?: string;
  /** HMAC key for evidence manifests (default `<homeDir>/.brokkr/key`). */
  signingKey?: Buffer;
  /**
   * Executes checks during `verify`. Inject one to run checks inside your own
   * worktrees or sandbox (spec §12.3). Defaults to Brokkr's `LocalProcessExecutor`.
   */
  executor?: CheckExecutor;
}

export interface VerifyInput {
  /** A selection from `resolve` (possibly JSON round-tripped). Its lock pins every digest. */
  selection: Selection;
  /** Absolute path of the exact tree to verify (for example a worktree). Nothing is written inside it: evidence goes to the run root under the Brokkr home, HMAC-signed. */
  workspace: string;
  /** Task recorded in the report; defaults to `selection.task`. */
  task?: TaskDescriptor;
  /** Aborting cancels running checks, keeps partial evidence and resolves with an interrupted report. */
  signal?: AbortSignal;
  /** Streaming events (spec §13.3), delivered synchronously in sequence order. */
  onEvent?: (event: VerificationEvent) => void;
  /** Execution correlation id carried by every event and recorded as the report's `executionId`. Generated when omitted. */
  correlationId?: string;
  /** Recorded as `repository.workspaceId`. */
  workspaceId?: string;
  /** Recorded as `projectId`; defaults to `project` in `.brokkr/config.yaml`. */
  projectId?: string;
  /** Environment the check environment is filtered from (allowlist only). Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface PrepareInput {
  selection: Selection;
  provider: ProviderId;
  /** Directory the bundle is written into (for example a worktree). Defaults to `cwd`. */
  workspace?: string;
  /** Allow the adapter to write a marked block into the project's own instruction files. */
  modifyProjectInstructions?: boolean;
}

export type CleanupInput = PrepareInput;

interface Opened {
  registry: Registry;
  config: ProjectConfig | undefined;
}

function adapterRefs(): AdapterRef[] {
  return PROVIDERS.map((id) => {
    const a = ADAPTERS[id]();
    return { id: a.id, version: a.version };
  });
}

function ref(h: { name: string; version: string }): string {
  return `${h.name}@${h.version}`;
}

/**
 * Brokkr public SDK (spec §12.2). Every method is read-only on the repository
 * except `prepare`/`cleanup` (instruction bundle) and `verify` (run evidence).
 */
export class Brokkr {
  readonly cwd: string;
  readonly offline: boolean;
  protected readonly logger: BrokkrLogger;
  protected readonly builtinDir: string;
  protected readonly homeDir: string;
  protected readonly executor: CheckExecutor | undefined;
  readonly trust: TrustMode;
  protected readonly inputs: Pick<
    BrokkrOptions,
    | "harnesses"
    | "profiles"
    | "lock"
    | "exceptions"
    | "policy"
    | "approvers"
    | "runRoot"
    | "signingKey"
  >;

  constructor(options: BrokkrOptions) {
    if (typeof options?.cwd !== "string" || options.cwd.length === 0)
      throw new BrokkrError("invalid-config", "new Brokkr({ cwd }) requires a repository path");
    this.cwd = resolvePath(options.cwd);
    this.offline = options.offline ?? false;
    this.logger = options.logger ?? SILENT;
    this.builtinDir = options.builtinDir ?? defaultBuiltinDir();
    this.homeDir = options.homeDir ?? homedir();
    this.executor = options.executor;
    const trust = options.trust ?? "workspace-untrusted";
    if (!TRUST_MODES.includes(trust))
      throw new BrokkrError(
        "invalid-config",
        `unknown trust mode '${String(trust)}'; expected ${TRUST_MODES.join(" or ")}`,
      );
    this.trust = trust;
    this.inputs = {
      ...(options.harnesses !== undefined ? { harnesses: options.harnesses } : {}),
      ...(options.profiles !== undefined ? { profiles: options.profiles } : {}),
      ...(options.lock !== undefined ? { lock: options.lock } : {}),
      ...(options.exceptions !== undefined ? { exceptions: options.exceptions } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.approvers !== undefined ? { approvers: options.approvers } : {}),
      ...(options.runRoot !== undefined ? { runRoot: options.runRoot } : {}),
      ...(options.signingKey !== undefined ? { signingKey: options.signingKey } : {}),
    };
  }

  /** Resolve harnesses and skills for a task. Runs nothing and writes nothing. */
  async resolve(input: ResolveInput): Promise<Selection> {
    const task = this.parseTask(input?.task);
    if (input.profile !== undefined && input.harnesses !== undefined)
      throw new BrokkrError("invalid-config", "resolve: give a profile or harnesses, not both");
    const { registry, config } = await this.open();
    const rationale: RationaleEntry[] = [];
    let requests: HarnessRequest[];
    let why: (name: string) => string;
    let profile: Profile | undefined;

    if (input.profile !== undefined) {
      profile = await this.findProfile(config, input.profile);
      requests = profile.harnesses;
      why = () => `listed by profile ${profile!.name}`;
    } else if (input.harnesses !== undefined) {
      requests = input.harnesses.map((h, i) => {
        const v = validateWith(HarnessRequestInputSchema, h, `harnesses[${i}]`);
        if (!v.ok) throw new BrokkrError("invalid-config", formatIssues(v.issues));
        return v.value;
      });
      if (requests.length === 0)
        throw new BrokkrError("invalid-config", "resolve: harnesses must not be empty");
      why = () => "requested";
    } else if (this.inputs.harnesses !== undefined && this.inputs.harnesses.length > 0) {
      requests = this.inputs.harnesses.map((h, i) =>
        this.checked(HarnessRequestInputSchema, h, `harnesses[${i}]`),
      );
      why = () => "default contract supplied by the caller";
    } else if (config && config.harnesses.length > 0) {
      requests = config.harnesses;
      why = () => "configured in .brokkr/config.yaml";
    } else {
      const auto = this.autoSelect(registry, task, await inspectRepo(this.cwd));
      requests = auto.requests;
      rationale.push(...auto.rejected);
      why = (name) => auto.reasons.get(name) ?? "selected";
    }

    const set = registry.resolve({
      harnesses: requests.map((h) => ({ name: h.name, range: h.version })),
    });
    const requested = new Set(requests.map((r) => r.name));
    for (const h of set.harnesses) {
      const name = h.manifest.metadata.name;
      rationale.push({
        kind: "harness",
        name,
        selected: true,
        reason: requested.has(name)
          ? why(name)
          : `dependency of ${h.requestedBy.filter((r) => r !== "request").join(", ")}`,
      });
    }
    // Composition rejects conflicting harnesses and reports differing check definitions.
    const composed = registry.compose(set);
    const skills = await resolveSkills({
      task,
      harnesses: set,
      repoSignals: await inspectRepo(this.cwd),
      ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    });
    for (const s of skills.skills)
      rationale.push({
        kind: "skill",
        name: s.name,
        selected: true,
        reason: s.reason,
        score: s.score,
      });
    for (const r of skills.rationale)
      rationale.push({
        kind: "skill",
        name: r.name,
        selected: false,
        reason: r.reason,
        ...(r.score !== undefined ? { score: r.score } : {}),
      });

    const selection: Selection = {
      schemaVersion: SELECTION_SCHEMA_VERSION,
      task,
      ...(profile ? { profile: profile.name } : {}),
      harnesses: set.harnesses.map(summarizeSelected),
      skills: skills.skills.map((s) => ({
        name: s.name,
        version: s.version,
        digest: set.skills[s.name]!.digest,
        reason: s.reason,
        ...(s.requiredBy !== undefined ? { requiredBy: s.requiredBy } : {}),
        score: s.score,
      })),
      lock: createLock(
        set,
        adapterRefs(),
        new Date(),
        profile ? { name: profile.name, digest: profileDigest(profile) } : undefined,
      ),
      rationale,
      warnings: [...composed.warnings, ...skills.warnings],
    };
    return selection;
  }

  /** Write the provider's instruction bundle for a selection. */
  async prepare(input: PrepareInput): Promise<PreparedContext> {
    const { adapter, ctx, skills } = await this.adapterContext(input);
    const env = await adapter.validateEnvironment(ctx);
    if (!env.compatible)
      throw new BrokkrError(
        "invalid-config",
        `${adapter.id} cannot prepare this task: ${env.issues.join("; ")}`,
      );
    for (const w of env.warnings) this.logger.warn({ provider: adapter.id }, w);
    return adapter.prepare(skills, ctx);
  }

  /** Remove exactly the files a previous `prepare` with the same input wrote. */
  async cleanup(input: CleanupInput): Promise<void> {
    const { adapter, ctx } = await this.adapterContext(input);
    await adapter.cleanup(ctx);
  }

  /**
   * Verify a workspace against a selection and return Brokkr's report. The
   * verdict is computed by Brokkr from deterministic check results and policy;
   * nothing in the input can override it. The contract (harnesses, lock,
   * policy, exceptions) comes from the constructor inputs per the trust mode;
   * the workspace's own `.brokkr/` is never read.
   * Rejects (after emitting `verification.failed`) only when no report can be
   * produced; a failed, incomplete or blocked verdict resolves normally.
   */
  async verify(input: VerifyInput): Promise<VerificationReport> {
    const correlationId = input?.correlationId ?? `exec_${randomUUID()}`;
    const sink = createEventSink<VerificationEvent>({
      correlationId,
      onEvent: input?.onEvent,
      onListenerError: (error) =>
        this.logger.warn({ error: String(error) }, "verification event listener threw"),
    });
    let runId: string | undefined;
    try {
      const workspace = this.checkWorkspace(input?.workspace);
      const { registry, config } = await this.open();
      const { selection, set, problems } = await this.materialize(input.selection, registry, {
        allowUntrusted: true,
        config,
      });
      const task = input.task !== undefined ? this.parseTask(input.task) : selection.task;
      const composed = registry.compose(set);

      const layers: PolicyLayerInput[] = [];
      const org = await loadOrgPolicy(this.homeDir);
      if (org) layers.push({ layer: "organization", policy: org });
      if (this.inputs.policy !== undefined)
        layers.push({
          layer: "project",
          policy: this.checked(PolicyLayerSchema, this.inputs.policy, "policy"),
        });
      if (config?.policies) layers.push({ layer: "project", policy: config.policies });
      // An unavailable or changed profile is already a lock_integrity problem (blocked).
      const profile =
        selection.profile !== undefined && problems.length === 0
          ? await this.findProfile(config, selection.profile)
          : undefined;
      if (profile !== undefined) {
        const policies = profile.overrides?.policies;
        if (policies !== undefined) {
          const v = validateWith(PolicyLayerSchema, policies, `profile ${profile.name}`);
          if (!v.ok)
            throw new BrokkrError(
              "invalid-config",
              `invalid profile policies:\n${formatIssues(v.issues)}`,
            );
          layers.push({ layer: "task", policy: v.value });
        }
      }
      const exceptions = [
        ...(this.inputs.exceptions ?? []).map((e, i) =>
          this.checked(ApprovedExceptionSchema, e, `exceptions[${i}]`),
        ),
        ...(this.trust === "developer" ? await loadExceptions(this.cwd) : []),
      ];
      if (this.inputs.lock !== undefined) {
        const pinned = this.checked(HarnessLockSchema, this.inputs.lock, "lock");
        if (pinned.digest !== selection.lock.digest)
          problems.push(
            `selection lock ${selection.lock.digest} does not match the pinned lock ${pinned.digest}`,
          );
      }
      const projectId = input.projectId ?? config?.project;
      const refs = set.harnesses.map(
        (h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version}`,
      );

      const onRunnerEvent = (e: VerifyEvent): void => {
        if (e.type === "run-start") {
          runId = e.runId;
          sink.emit("verification.started", {
            runId: e.runId,
            runDir: e.runDir,
            workspace,
            ...(task ? { taskId: task.id } : {}),
            harnesses: refs,
            checks: e.checks,
          });
        } else if (e.type === "check-start") {
          sink.emit("verification.check.started", {
            runId,
            checkId: e.checkId,
            command: e.command,
          });
        } else if (e.type === "check-end") {
          sink.emit("verification.check.completed", {
            runId,
            checkId: e.result.id,
            result: e.result,
          });
        } else {
          sink.emit(e.report.interrupted ? "verification.cancelled" : "verification.completed", {
            runId: e.report.id,
            runDir: e.runDir,
            verdict: e.report.verdict,
            summary: e.report.summary,
            reasons: e.report.reasons,
          });
        }
      };

      const outcome = await runVerification({
        workspace,
        set,
        composed,
        lockDigest: selection.lock.digest,
        lockProblems: problems,
        task,
        ...(projectId !== undefined ? { projectId } : {}),
        executionId: correlationId,
        ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        layers,
        exceptions,
        ...(this.executor ? { executor: this.executor } : {}),
        env: input.env ?? process.env,
        ...(input.signal ? { signal: input.signal } : {}),
        onEvent: onRunnerEvent,
        // Read after the checks, with containment enforced at read time (N2).
        readBundles: () => readGeneratedBundles(workspace),
        warnings: [...selection.warnings],
        trustMode: this.trust,
        home: this.homeDir,
        ...(this.inputs.approvers ? { approvers: [...this.inputs.approvers] } : {}),
        ...(this.inputs.runRoot ? { runRoot: this.inputs.runRoot } : {}),
        ...(this.inputs.signingKey ? { signingKey: this.inputs.signingKey } : {}),
      });
      return outcome.report;
    } catch (error) {
      const code = error instanceof BrokkrError ? error.code : "infra";
      sink.emit("verification.failed", {
        ...(runId !== undefined ? { runId } : {}),
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
      if (error instanceof BrokkrError) throw error;
      throw new BrokkrError("infra", `verification failed: ${String(error)}`, { cause: error });
    }
  }

  /**
   * Read a stored run (`<homeDir>/.brokkr/runs/<sha256(workspace)>/<id>`) and verify
   * its signature and every artifact digest. `integrity.status` is
   * `integrity_failed` when evidence changed or the run is unsigned or forged.
   */
  readReport(runDir: string): Promise<StoredReport> {
    return readStoredReport(resolvePath(runDir), {
      home: this.homeDir,
      ...(this.inputs.signingKey ? { key: this.inputs.signingKey } : {}),
    });
  }

  /** Every harness visible to this repository (latest first per name is not applied: all versions). */
  async listHarnesses(): Promise<HarnessSummary[]> {
    const { registry } = await this.open();
    return registry
      .list()
      .map(summarize)
      .sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version));
  }

  /** Read-only repository signals (package manager, frameworks, scripts, test runners). */
  inspectRepo(): Promise<RepoSignals> {
    return inspectRepo(this.cwd);
  }

  // ---------------------------------------------------------------- internals

  protected checkWorkspace(workspace: unknown): string {
    if (typeof workspace !== "string" || workspace.length === 0)
      throw new BrokkrError("invalid-config", "verify: workspace must be a directory path");
    const abs = resolvePath(this.cwd, workspace);
    if (!existsSync(abs) || !statSync(abs).isDirectory())
      throw new BrokkrError("invalid-config", `verify: workspace ${abs} is not a directory`);
    return abs;
  }

  protected parseTask(task: unknown): TaskDescriptor {
    const v = validateWith(TaskDescriptorSchema, task, "task");
    if (!v.ok)
      throw new BrokkrError("invalid-config", `invalid task:\n${formatIssues(v.issues)}`, {
        details: { issues: v.issues },
      });
    return v.value;
  }

  protected async open(): Promise<Opened> {
    const developer = this.trust === "developer";
    const config = developer ? await loadProjectConfig(this.cwd) : undefined;
    const registry = new Registry({
      cwd: this.cwd,
      builtinDir: this.builtinDir,
      homeDir: this.homeDir,
      ...(config ? { config } : {}),
      ...(developer
        ? {}
        : {
            projectSources: false,
            // Review I3: no user harness shadows a built-in unless the pinned lock trusts it.
            refuseShadowing: {
              allow: (this.inputs.lock?.harnesses ?? [])
                .filter((h) => h.source !== "builtin")
                .map((h) => `${h.name}@${h.version}`),
            },
          }),
    });
    await registry.load();
    for (const d of registry.diagnostics)
      this.logger.warn({ diagnostic: d }, "registry diagnostic");
    return { registry, config };
  }

  protected async findProfile(config: ProjectConfig | undefined, name: string): Promise<Profile> {
    const builtin = await this.builtinProfile(name);
    const supplied = [
      ...(this.inputs.profiles ?? []).map((p, i) =>
        this.checked(ProfileSchema, p, `profiles[${i}]`),
      ),
      ...(config?.profiles ?? []),
    ].find((p) => p.name === name);
    if (supplied && builtin)
      throw new BrokkrError(
        "invalid-config",
        `profile '${name}' shadows the built-in profile of the same name; rename it`,
      );
    const found = supplied ?? builtin;
    if (found) return found;
    throw new BrokkrError(
      "not-found",
      this.trust === "developer"
        ? `profile '${name}' is not defined in .brokkr/config.yaml, the caller's profiles or the built-in profiles`
        : `profile '${name}' is not a built-in or caller-supplied profile`,
    );
  }

  private async builtinProfile(name: string): Promise<Profile | undefined> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
    for (const ext of ["yaml", "yml", "json"]) {
      const file = join(this.builtinDir, "profiles", `${name}.${ext}`);
      if (!existsSync(file)) continue;
      const parsed = parseManifestText(await readFile(file, "utf8"), ProfileSchema, file);
      if (!parsed.ok)
        throw new BrokkrError("invalid-config", `invalid profile:\n${formatIssues(parsed.issues)}`);
      return parsed.value;
    }
    return undefined;
  }

  /** Validate a caller input or throw `invalid-config`. */
  protected checked<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
    const v = validateWith(schema, value, label);
    if (!v.ok)
      throw new BrokkrError("invalid-config", `invalid ${label}:\n${formatIssues(v.issues)}`);
    return v.value;
  }

  private autoSelect(
    registry: Registry,
    task: TaskDescriptor,
    signals: RepoSignals,
  ): { requests: HarnessRequest[]; reasons: Map<string, string>; rejected: RationaleEntry[] } {
    const latest = new Map<string, HarnessManifest>();
    for (const h of registry.list()) {
      if (h.trust !== "trusted") continue;
      const cur = latest.get(h.manifest.metadata.name);
      if (!cur || semver.gt(h.manifest.metadata.version, cur.metadata.version))
        latest.set(h.manifest.metadata.name, h.manifest);
    }
    const wanted = new Set([...(task.taskTypes ?? []), ...(task.tags ?? [])]);
    const reasons = new Map<string, string>();
    for (const m of latest.values()) {
      const hit = m.compatibility.taskTypes.filter((t) => wanted.has(t)).sort();
      if (hit.length > 0) reasons.set(m.metadata.name, `task types/tags match: ${hit.join(", ")}`);
    }
    if (reasons.size === 0)
      for (const rec of recommendHarnesses([...latest.values()], signals))
        reasons.set(rec.name, rec.reason);
    if (reasons.size === 0)
      throw new BrokkrError(
        "not-found",
        "no harness matches this task's types or tags or the repository's signals; pass a profile or harnesses",
      );
    const rejected: RationaleEntry[] = [...latest.keys()]
      .filter((n) => !reasons.has(n))
      .sort()
      .map((name) => ({
        kind: "harness",
        name,
        selected: false,
        reason: "no task type, tag or repository signal matched",
      }));
    const requests = [...reasons.keys()]
      .sort()
      .map((name) => ({ name, version: latest.get(name)!.metadata.version }));
    return { requests, reasons, rejected };
  }

  /**
   * Re-resolve a selection against the registry and compare every pinned
   * digest. Returns the set plus a list of integrity problems (empty when the
   * installed content is exactly what was selected).
   */
  protected async materialize(
    raw: Selection,
    registry: Registry,
    options: { allowUntrusted?: boolean; config?: ProjectConfig | undefined } = {},
  ): Promise<{ selection: Selection; set: ResolvedHarnessSet; problems: string[] }> {
    const v = validateWith(SelectionSchema, raw, "selection");
    if (!v.ok)
      throw new BrokkrError("invalid-config", `invalid selection:\n${formatIssues(v.issues)}`);
    const selection = v.value as Selection;
    const set = registry.resolve({
      harnesses: selection.harnesses.map((h) => ({ name: h.name, range: h.version })),
      ...(options.allowUntrusted ? { allowUntrusted: true } : {}),
    });
    const problems: string[] = [];
    const lock = selection.lock;
    if (lockContentDigest(lock) !== lock.digest)
      problems.push("selection lock digest does not match its content");
    for (const h of selection.harnesses) {
      const got = set.harnesses.find((x) => x.manifest.metadata.name === h.name);
      const locked = lock.harnesses.find((x) => x.name === h.name);
      if (!got || got.manifest.metadata.version !== h.version)
        problems.push(`harness ${ref(h)} is not available`);
      else if (got.digest !== h.digest) problems.push(`harness ${ref(h)} modified`);
      if (!locked || locked.version !== h.version || locked.digest !== h.digest)
        problems.push(`harness ${ref(h)} is not pinned by the selection lock`);
    }
    for (const h of set.harnesses)
      if (!selection.harnesses.some((s) => s.name === h.manifest.metadata.name))
        problems.push(`harness ${h.manifest.metadata.name} is not part of the selection`);
    // The lock pins the whole set (review C1): every pinned harness must be selected and resolved.
    for (const l of lock.harnesses) {
      const sel = selection.harnesses.find((h) => h.name === l.name);
      if (!sel || sel.version !== l.version || sel.digest !== l.digest)
        problems.push(`harness ${ref(l)} is pinned by the lock but not selected`);
    }
    for (const l of lock.skills) {
      const got = set.skills[l.name];
      if (!got || got.manifest.metadata.version !== l.version || got.digest !== l.digest)
        problems.push(`skill ${ref(l)} is pinned by the lock but not provided`);
    }
    // The lock pins the profile by name and content digest (fix round 2, N1).
    const pinnedProfile = lock.profile;
    if (pinnedProfile !== undefined && selection.profile !== pinnedProfile.name)
      problems.push(
        `profile ${pinnedProfile.name} is pinned by the lock but the selection names ${selection.profile ?? "no profile"}`,
      );
    if (pinnedProfile === undefined && selection.profile !== undefined)
      problems.push(`selection names profile ${selection.profile} but the lock pins no profile`);
    if (selection.profile !== undefined) {
      let profile: Profile | undefined;
      try {
        profile = await this.findProfile(options.config, selection.profile);
      } catch (error) {
        // A malformed caller profile is a configuration error, not an integrity finding (m2).
        if (error instanceof BrokkrError && error.code === "invalid-config") throw error;
        problems.push(`profile ${selection.profile} is not available`);
      }
      if (
        profile !== undefined &&
        pinnedProfile?.name === profile.name &&
        pinnedProfile.digest !== profileDigest(profile)
      )
        problems.push(`profile ${profile.name} changed since it was pinned`);
      for (const h of profile?.harnesses ?? [])
        if (!selection.harnesses.some((s) => s.name === h.name))
          problems.push(
            `profile ${selection.profile} requires harness ${h.name}, which is not selected`,
          );
    }
    for (const s of selection.skills) {
      const got = set.skills[s.name];
      const locked = lock.skills.find((x) => x.name === s.name);
      if (!got) problems.push(`skill ${s.name} is not shipped by the selected harnesses`);
      else if (got.manifest.metadata.version !== s.version || got.digest !== s.digest)
        problems.push(`skill ${ref(s)} modified`);
      if (!locked || locked.digest !== s.digest)
        problems.push(`skill ${s.name} is not pinned by the selection lock`);
    }
    return { selection, set, problems };
  }

  private async adapterContext(input: PrepareInput): Promise<{
    adapter: ProviderAdapter;
    ctx: AdapterContext;
    skills: ResolvedSkill[];
  }> {
    const factory = (ADAPTERS as Record<string, (() => ProviderAdapter) | undefined>)[
      input?.provider
    ];
    if (!factory)
      throw new BrokkrError(
        "invalid-config",
        `unknown provider '${String(input?.provider)}'; expected one of ${PROVIDERS.join(", ")}`,
      );
    const { registry, config } = await this.open();
    const { selection, set, problems } = await this.materialize(input.selection, registry, {
      config,
    });
    if (problems.length > 0)
      throw new BrokkrError(
        "integrity",
        `refusing to prepare instructions: ${problems.join("; ")}`,
        { details: { problems } },
      );
    const untrusted = set.harnesses.filter((h) => h.trust !== "trusted" || !h.executionAllowed);
    if (untrusted.length > 0)
      throw new BrokkrError(
        "trust_required",
        `refusing to prepare instructions from untrusted sources: ${untrusted.map((h) => h.sourceRef).join(", ")}`,
      );
    const ctx: AdapterContext = {
      cwd: resolvePath(input.workspace ?? this.cwd),
      task: selection.task,
      composed: registry.compose(set),
      skillCatalog: set.skills,
      modifyProjectInstructions: input.modifyProjectInstructions === true,
    };
    const skills: ResolvedSkill[] = selection.skills.map((s) => ({
      name: s.name,
      version: s.version,
      selected: true,
      reason: s.reason,
      ...(s.requiredBy !== undefined ? { requiredBy: s.requiredBy } : {}),
      score: s.score,
    }));
    return { adapter: factory(), ctx, skills };
  }
}

/** Digest of a resolved profile (harness requests, overrides and policies) pinned in the lock. */
function profileDigest(profile: Profile): string {
  // Harness requests are a set: their order does not change the contract (m-c).
  const harnesses = [...profile.harnesses].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
  );
  return sha256Digest(canonicalJson({ ...profile, harnesses }));
}

function checksOf(h: LoadedHarness): Array<{ id: string; required: boolean }> {
  return h.manifest.checks.map((c) => ({ id: c.id, required: c.required }));
}

function summarizeSelected(h: ResolvedHarnessSet["harnesses"][number]): SelectedHarness {
  return {
    name: h.manifest.metadata.name,
    version: h.manifest.metadata.version,
    digest: h.digest,
    description: h.manifest.metadata.description,
    taskTypes: [...h.manifest.compatibility.taskTypes],
    source: h.source,
    sourceRef: h.sourceRef,
    trust: h.trust,
    executionAllowed: h.executionAllowed,
    checks: checksOf(h),
  };
}

function summarize(h: LoadedHarness): HarnessSummary {
  return {
    name: h.manifest.metadata.name,
    version: h.manifest.metadata.version,
    description: h.manifest.metadata.description,
    taskTypes: [...h.manifest.compatibility.taskTypes],
    source: h.source,
    sourceRef: h.sourceRef,
    trust: h.trust,
    digest: h.digest,
    skills: {
      required: [...h.manifest.skills.required],
      optional: [...h.manifest.skills.optional],
    },
    checks: checksOf(h),
  };
}
