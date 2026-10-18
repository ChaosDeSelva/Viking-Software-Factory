import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROKKR_VERSION,
  BrokkrError,
  REPORT_SCHEMA_VERSION,
  computeVerdict,
  exitCodeForVerdict,
  summarizeChecks,
  type AppliedException,
  type ApprovedException,
  type CheckResult,
  type ComposedCheck,
  type ComposedHarness,
  type ExitCode,
  type PolicyDecision,
  type PolicySource,
  type ResolvedHarnessSet,
  type TaskDescriptor,
  type VerificationReport,
} from "@brokkr/core";
import {
  createRun,
  defaultBrokkrHome,
  finalizeRun,
  repositoryState,
  signingKey,
  type RunHandle,
} from "@brokkr/evidence";
import { brokkrHomeSnapshot, snapshotChanges } from "./homeguard.js";
import {
  SYSTEM_POLICY,
  applyNetworkPolicy,
  createLineRedactor,
  evaluateAfter,
  evaluateBefore,
  findApproval,
  harnessLayer,
  mergePolicies,
  redactText,
  scanText,
  type EffectivePolicy,
  type PlannedCheck,
  type PolicyLayerInput,
} from "@brokkr/policy";
import { renderMarkdown } from "@brokkr/reporters";
import { buildCheckEnv, secretEnvValues } from "./env.js";
import { LocalProcessExecutor, type CheckExecutionResult, type CheckExecutor } from "./executor.js";
import type { TrustMode } from "./contract.js";
import { dependencyInstallNeeded, preflightCheck } from "./preflight.js";

export type VerifyEvent =
  | { type: "run-start"; runId: string; runDir: string; checks: number }
  | { type: "check-start"; checkId: string; command: string[] }
  | { type: "check-end"; result: CheckResult; outputTail?: string }
  | { type: "run-end"; report: VerificationReport; runDir: string };

export interface VerifyOptions {
  /** Absolute workspace (repository or worktree) to verify. */
  workspace: string;
  set: ResolvedHarnessSet;
  composed: ComposedHarness;
  /** Digest of the harness lock in effect (recorded in the report). */
  lockDigest: string;
  /** Lock integrity problems; any entry blocks the run (`lock_integrity`). */
  lockProblems?: string[];
  task?: TaskDescriptor;
  projectId?: string;
  executionId?: string;
  workspaceId?: string;
  /** Organization, project and task layers; system and harness layers are added here. */
  layers?: PolicyLayerInput[];
  exceptions?: ApprovedException[];
  /** Where exceptions and policy layers were loaded from (recorded in the report). */
  policySources?: PolicySource[];
  executor?: CheckExecutor;
  /** Caller environment the check environment is filtered from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onEvent?: (event: VerifyEvent) => void;
  /**
   * Reads generated bundles after the checks have run (the caller enforces
   * containment at read time; see `readGeneratedBundles`). Its texts are secret-scanned; its
   * warnings are added to the report.
   */
  readBundles?: () => Promise<{
    files: Array<{ file: string; text: string }>;
    warnings: string[];
  }>;
  reviewRecorded?: boolean;
  maxLogBytes?: number;
  killGraceMs?: number;
  warnings?: string[];
  now?: () => Date;
  /** Brokkr home holding the runs store and signing key (default `$BROKKR_HOME` or `~`). */
  home?: string;
  /** Explicit runs root (default `<home>/.brokkr/runs/<sha256(workspace)>`). */
  runsRoot?: string;
  /** Same as `runsRoot` (SDK spelling): directory that receives `run_<ulid>/`. */
  runRoot?: string;
  /** HMAC key for the evidence manifest (default: `<home>/.brokkr/key`). */
  signingKey?: Buffer;
  /**
   * Default `workspace-untrusted`: harness-declared waivers are ignored (only
   * organization/project policy may make a check waivable), exceptions count
   * only when `approvedBy` is one of `approvers`, and omitting `lockProblems`
   * (no lock verification) blocks the run. `developer` keeps the permissive
   * behaviour for a developer verifying their own repository.
   */
  trustMode?: TrustMode;
  /** Approver identities the caller trusts (workspace-untrusted mode). */
  approvers?: string[];
}

export interface VerifyOutcome {
  report: VerificationReport;
  runDir: string;
  interrupted: boolean;
  exitCode: ExitCode;
}

const SKIP_REASONS = new Set([
  "missing_tool",
  "missing_script",
  "condition_not_met",
  "not_applicable",
]);

function harnessDirFor(check: ComposedCheck, set: ResolvedHarnessSet): string | undefined {
  const ref = check.from[0];
  return set.harnesses.find(
    (h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version}` === ref,
  )?.dir;
}

/** Group consecutive `parallel: true` checks; everything else runs alone, in order. */
function groups<T extends { def: { parallel?: boolean | undefined } }>(
  checks: readonly T[],
): T[][] {
  const out: T[][] = [];
  for (const c of checks) {
    const last = out[out.length - 1];
    if (c.def.parallel && last && last[0]?.def.parallel) last.push(c);
    else out.push([c]);
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs)));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** Scan text artifacts written by checks; redact secrets at rest and report findings. */
async function scrubArtifacts(dir: string): Promise<Array<{ file: string; findings: number }>> {
  const found: Array<{ file: string; findings: number }> = [];
  for (const file of await walk(dir)) {
    const st = await lstat(file);
    if (!st.isFile() || st.size > 32 * 1024 * 1024) continue;
    const buf = await readFile(file);
    if (buf.includes(0)) continue; // binary (e.g. screenshots)
    const text = buf.toString("utf8");
    if (scanText(text).length === 0) continue;
    const redacted = redactText(text);
    await writeFile(file, redacted.text);
    found.push({ file, findings: redacted.findings });
  }
  return found;
}

function toResult(
  check: PlannedCheck,
  extra: Partial<CheckResult> & Pick<CheckResult, "state">,
): CheckResult {
  return {
    id: check.id,
    required: check.required,
    ...(check.required ? { requiredBy: check.requiredBy ?? "harness" } : {}),
    command: [...check.command],
    cwd: check.cwd,
    from: [...check.from],
    durationMs: 0,
    ...extra,
  };
}

/**
 * The verification pipeline: policy before → preflight + execute checks →
 * policy after → verdict → evidence. Never reports an incomplete run as a pass.
 */
export async function runVerification(options: VerifyOptions): Promise<VerifyOutcome> {
  const now = options.now ?? (() => new Date());
  if (!existsSync(options.workspace))
    throw new BrokkrError("invalid-config", `workspace ${options.workspace} does not exist`);
  const executor = options.executor ?? new LocalProcessExecutor();
  const callerEnv = options.env ?? process.env;
  const startedAt = now();
  const warnings = [...(options.warnings ?? [])];
  const repo = await repositoryState(options.workspace);
  warnings.push(...repo.warnings);
  const run: RunHandle = await createRun(options.workspace, {
    ...(options.home ? { home: options.home } : {}),
    ...((options.runRoot ?? options.runsRoot)
      ? { runsRoot: (options.runRoot ?? options.runsRoot)! }
      : {}),
  });

  const trustMode: TrustMode = options.trustMode ?? "workspace-untrusted";
  const untrustedMode = trustMode === "workspace-untrusted";

  // workspace-untrusted: checks get a scratch HOME/XDG dirs, and the Brokkr home is
  // snapshotted now and verified after the checks (fix round 2, I3).
  const brokkrHome = options.home ?? defaultBrokkrHome();
  let scratchHome: string | undefined;
  let homeBefore: Map<string, string> | undefined;
  if (untrustedMode) {
    if (!options.signingKey) await signingKey(brokkrHome); // created now, not mid-run
    homeBefore = await brokkrHomeSnapshot(brokkrHome);
    scratchHome = await mkdtemp(join(tmpdir(), "brokkr-check-home-"));
    for (const d of [".config", ".local/share", ".cache", ".local/state"])
      await mkdir(join(scratchHome, d), { recursive: true });
  }
  const policy: EffectivePolicy = mergePolicies([
    { layer: "system", policy: SYSTEM_POLICY },
    ...(options.layers ?? []).filter((l) => l.layer === "organization" || l.layer === "project"),
    {
      layer: "harness",
      // In workspace-untrusted mode harness-declared `waivable` flags are ignored.
      policy: harnessLayer(
        options.composed.policies,
        untrustedMode
          ? options.composed.checks.map((c) => ({ id: c.id }))
          : options.composed.checks,
      ),
    },
    ...(options.layers ?? []).filter((l) => l.layer === "task"),
    ...(options.task?.policies ? [{ layer: "task" as const, policy: options.task.policies }] : []),
  ]);

  const required = new Set(policy.requiredCheckIds);
  const planned: Array<PlannedCheck & { def: ComposedCheck }> = options.composed.checks.map(
    (c) => ({
      id: c.id,
      command: [...c.command],
      cwd: c.cwd ?? ".",
      required: c.required || required.has(c.id),
      requiredBy: required.has(c.id) ? ("policy" as const) : ("harness" as const),
      timeoutSeconds: c.timeoutSeconds,
      from: [...c.from],
      ...(c.waivable !== undefined ? { waivable: c.waivable } : {}),
      def: c,
    }),
  );
  const harnessRefs = options.set.harnesses.map(
    (h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version}`,
  );
  const untrusted = options.set.harnesses
    .filter((h) => !h.executionAllowed)
    .map((h) => `${h.manifest.metadata.name}@${h.manifest.metadata.version} (${h.sourceRef})`);
  const evalCtx = {
    ...(options.task ? { taskId: options.task.id } : {}),
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    harnesses: harnessRefs,
    now: startedAt,
  };
  const approvers = new Set(options.approvers ?? []);
  const exceptions = (options.exceptions ?? []).filter((e) => {
    if (!untrustedMode || approvers.has(e.approvedBy)) return true;
    warnings.push(
      `exception ${e.id} ignored: approvedBy '${e.approvedBy}' is not a caller-trusted approver (workspace-untrusted mode)`,
    );
    return false;
  });
  const before = evaluateBefore(
    { checks: planned, untrustedHarnesses: untrusted },
    policy,
    exceptions,
    evalCtx,
  );
  const decisions: PolicyDecision[] = [...before.decisions];
  const blocked = [...before.blocked];
  if (untrustedMode && options.lockProblems === undefined) {
    const message =
      "no lock verification was supplied (workspace-untrusted mode requires a pinned lock)";
    blocked.push(`lock_integrity: ${message}`);
    decisions.push({
      policy: "lock-integrity",
      stage: "before",
      outcome: "deny",
      layer: "system",
      message,
    });
  }
  for (const problem of options.lockProblems ?? []) {
    blocked.push(`lock_integrity: ${problem}`);
    decisions.push({
      policy: "lock-integrity",
      stage: "before",
      outcome: "deny",
      layer: "system",
      message: problem,
    });
  }
  warnings.push(...before.warnings);
  for (const source of options.policySources ?? []) {
    if (source.origin !== "workspace_supplied") continue;
    decisions.push({
      policy: "policy-source",
      stage: "before",
      outcome: "warn",
      layer: source.kind === "organization-policy" ? "organization" : "project",
      message: `${source.kind} loaded from ${source.path} inside the workspace being verified (workspace_supplied): the work under test could have written it`,
    });
  }

  options.onEvent?.({ type: "run-start", runId: run.id, runDir: run.dir, checks: planned.length });
  const results = new Map<string, CheckResult>();
  const knownSecrets = secretEnvValues(callerEnv);

  const runOne = async (check: (typeof planned)[number]): Promise<CheckResult> => {
    if (blocked.length > 0) {
      const isUntrusted = untrusted.length > 0;
      return toResult(check, {
        state: "skipped",
        reason: isUntrusted ? "untrusted_source" : "policy_denied",
        message:
          before.denied.get(check.id) ??
          (isUntrusted
            ? "not executed: untrusted harness source"
            : "not executed: run blocked by policy"),
      });
    }
    const waiver = before.waived.get(check.id);
    if (waiver)
      return toResult(check, {
        state: "skipped",
        reason: "exception",
        exceptionId: waiver,
        message: `waived by exception ${waiver}`,
      });
    const networkDenied = before.networkDenied.get(check.id);
    if (networkDenied)
      return toResult(check, {
        state: "skipped",
        reason: "network_denied",
        message: networkDenied,
      });
    if (options.signal?.aborted)
      return toResult(check, {
        state: "cancelled",
        reason: "cancelled",
        message: "not started: run interrupted",
      });

    const { env: filtered, refused } = buildCheckEnv(callerEnv, check.def.env ?? []);
    if (refused.length > 0)
      warnings.push(
        `check '${check.id}': secret-looking variables ${refused.join(", ")} were not passed`,
      );
    const harnessDir = harnessDirFor(check.def, options.set);
    const pre = await preflightCheck(
      { id: check.id, command: check.command, cwd: check.cwd, when: check.def.when },
      {
        workspace: options.workspace,
        path: filtered.PATH ?? "",
        ...(harnessDir ? { harnessDir } : {}),
      },
    );
    if (!pre.ok && pre.reason === "policy_denied") {
      // e.g. the binary is an alias of a denied command: a policy denial blocks the run.
      blocked.push(`destructive-commands: ${pre.message}`);
      decisions.push({
        policy: "destructive-commands",
        stage: "runtime",
        outcome: "deny",
        layer: "system",
        checkId: check.id,
        message: pre.message,
      });
      return toResult(check, {
        command: pre.command,
        state: "skipped",
        reason: "policy_denied",
        message: pre.message,
      });
    }
    if (!pre.ok) {
      return toResult(check, {
        command: pre.command,
        state: SKIP_REASONS.has(pre.reason) ? "skipped" : "errored",
        reason: pre.reason,
        message: pre.message,
      });
    }
    const install = await dependencyInstallNeeded(pre.command, pre.cwdDir, options.workspace);
    if (install && !findApproval(exceptions, "install-dependencies", evalCtx)) {
      blocked.push(`install-dependencies: ${install}`);
      decisions.push({
        policy: "install-dependencies",
        stage: "runtime",
        outcome: "require_approval",
        layer: "system",
        checkId: check.id,
        message: install,
      });
      return toResult(check, {
        command: pre.command,
        state: "skipped",
        reason: "policy_denied",
        message: install,
      });
    }
    const testResultsDir = run.testResultsDir(check.id);
    const screenshotsDir = run.screenshotsDir(check.id);
    await mkdir(testResultsDir, { recursive: true });
    await mkdir(screenshotsDir, { recursive: true });
    const env = applyNetworkPolicy(
      before.networkApproved.has(check.id) ? "allow" : policy.network,
      {
        ...filtered,
        ...(scratchHome
          ? {
              HOME: scratchHome,
              XDG_CONFIG_HOME: join(scratchHome, ".config"),
              XDG_DATA_HOME: join(scratchHome, ".local/share"),
              XDG_CACHE_HOME: join(scratchHome, ".cache"),
              XDG_STATE_HOME: join(scratchHome, ".local/state"),
            }
          : {}),
        BROKKR_CHECK_ID: check.id,
        BROKKR_TEST_RESULTS_DIR: testResultsDir,
        BROKKR_SCREENSHOTS_DIR: screenshotsDir,
      },
    );
    options.onEvent?.({ type: "check-start", checkId: check.id, command: pre.command });
    await run.assertIntact(); // an earlier check may have swapped the run directory
    const exec: CheckExecutionResult = await executor.execute(
      {
        checkId: check.id,
        command: pre.command,
        workspace: options.workspace,
        cwd: check.cwd,
        env,
        timeoutMs: check.timeoutSeconds * 1000,
        logFile: run.logPath(check.id),
        ...(options.maxLogBytes !== undefined ? { maxLogBytes: options.maxLogBytes } : {}),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        createRedactor: () => createLineRedactor({ knownValues: knownSecrets }),
      },
      options.signal,
    );
    const result = toResult(check, {
      command: pre.command,
      state: exec.state,
      exitCode: exec.exitCode,
      signal: exec.signal,
      startedAt: exec.startedAt,
      completedAt: exec.completedAt,
      durationMs: exec.durationMs,
      outputBytes: exec.outputBytes,
      truncated: exec.truncated,
      secretFindings: exec.secretFindings,
      ...(exec.reason ? { reason: exec.reason } : {}),
      ...(exec.error ? { message: exec.error } : {}),
      ...(exec.maxRssBytes !== undefined ? { maxRssBytes: exec.maxRssBytes } : {}),
      ...(existsSync(run.logPath(check.id)) ? { log: `logs/${check.id}.log` } : {}),
    });
    options.onEvent?.({ type: "check-end", result, outputTail: exec.outputTail });
    return result;
  };

  for (const group of groups(planned)) {
    const out = await Promise.all(
      group.map(async (check) => {
        const r = await runOne(check);
        if (!r.startedAt) options.onEvent?.({ type: "check-end", result: r });
        return r;
      }),
    );
    for (const r of out) results.set(r.id, r);
  }
  const checks = planned.map((c) => results.get(c.id)!);

  if (scratchHome) await rm(scratchHome, { recursive: true, force: true });
  if (homeBefore) {
    const changed = snapshotChanges(homeBefore, await brokkrHomeSnapshot(brokkrHome));
    if (changed.length > 0) {
      const message = `the Brokkr home ${join(brokkrHome, ".brokkr")} changed during the run: ${changed.join(", ")}`;
      blocked.push(`home_tampered: ${message}`);
      decisions.push({
        policy: "home-integrity",
        stage: "after",
        outcome: "deny",
        layer: "system",
        message,
      });
    }
  }

  // Refuse swapped paths before artifact scanning can read or redact outside files.
  await run.assertIntact();
  const artifactFindings = [
    ...(await scrubArtifacts(join(run.dir, "test-results"))),
    ...(await scrubArtifacts(join(run.dir, "screenshots"))),
  ];
  const bundleFindings = [];
  if (options.readBundles) {
    const read = await options.readBundles();
    warnings.push(...read.warnings);
    for (const { file, text } of read.files) {
      const n = scanText(text).length;
      if (n > 0) bundleFindings.push({ file, findings: n });
    }
  }
  const after = evaluateAfter(checks, policy, {
    exceptions,
    ctx: evalCtx,
    bundleFindings: [
      ...bundleFindings,
      ...artifactFindings.map((f) => ({ ...f, file: f.file.slice(run.dir.length + 1) })),
    ],
    ...(options.reviewRecorded !== undefined ? { reviewRecorded: options.reviewRecorded } : {}),
  });
  decisions.push(...after.decisions);
  blocked.push(...after.blocked);

  const interrupted = options.signal?.aborted === true;
  const verdict = computeVerdict({
    checks: checks.map((c) => ({
      id: c.id,
      required: c.required,
      state: c.state,
      ...(c.exceptionId ? { exceptionId: c.exceptionId } : {}),
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.requiredBy ? { requiredBy: c.requiredBy } : {}),
    })),
    blocked,
    unmet: after.unmet,
  });
  const reasons = interrupted ? ["run interrupted", ...verdict.reasons] : verdict.reasons;
  const exceptionsOrigin = options.policySources?.find((p) => p.kind === "exceptions")?.origin;
  const applied: AppliedException[] = [...before.applied, ...after.applied].map((e) =>
    exceptionsOrigin ? { ...e, origin: exceptionsOrigin } : e,
  );
  const names = options.composed.harnesses;
  const report: VerificationReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: run.id,
    trustMode,
    ...(options.executionId ? { executionId: options.executionId } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.task ? { taskId: options.task.id } : {}),
    harness: {
      name: names.map((h) => h.name).join("+") || "none",
      version: names.map((h) => h.version).join("+") || "none",
      lockDigest: options.lockDigest,
    },
    harnesses: options.set.harnesses.map((h) => ({
      name: h.manifest.metadata.name,
      version: h.manifest.metadata.version,
      digest: h.digest,
    })),
    repository: {
      commitSha: repo.commitSha,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(repo.dirtyTreeDigest ? { dirtyTreeDigest: repo.dirtyTreeDigest } : {}),
    },
    startedAt: startedAt.toISOString(),
    completedAt: now().toISOString(),
    verdict: verdict.verdict,
    reasons,
    ...(interrupted ? { interrupted: true } : {}),
    checks,
    policyDecisions: decisions,
    exceptions: applied,
    ...(options.policySources ? { policySources: options.policySources } : {}),
    evidence: [],
    summary: summarizeChecks(checks),
    environment: {
      brokkrVersion: BROKKR_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    warnings,
  };
  // Workspace code has run: never write evidence through a swapped run directory.
  await run.assertIntact();
  const final = await finalizeRun(run.dir, report, {
    markdown: renderMarkdown,
    workspace: options.workspace,
    ...(options.home ? { home: options.home } : {}),
    ...(options.signingKey ? { key: options.signingKey } : {}),
  });
  options.onEvent?.({ type: "run-end", report: final, runDir: run.dir });
  return {
    report: final,
    runDir: run.dir,
    interrupted,
    exitCode: exitCodeForVerdict(final.verdict, { interrupted }),
  };
}
