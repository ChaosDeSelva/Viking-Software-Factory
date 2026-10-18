import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrokkrError,
  ExceptionsFileSchema,
  POLICY_LAYERS,
  PolicyLayerSchema,
  formatIssues,
  isSafeRelativePath,
  parseManifestText,
  type AllowDeny,
  type AppliedException,
  type ApprovedException,
  type CheckResult,
  type PolicyDecision,
  type PolicyLayer,
  type PolicyLayerName,
  type Policies,
} from "@brokkr/core";
import { analyzeCommand, globToRegExp } from "./command.js";

/** Security policies an exception can never waive (spec §9.3). */
export const SECURITY_POLICY_IDS = [
  "untrusted-source",
  "destructive-commands",
  "secret-exposure",
  "filesystem",
  "command-allowlist",
  "lock-integrity",
] as const;

/** Approval-type policies: an approval record (exception) grants them for its scope. */
export const APPROVAL_POLICY_IDS = ["install-dependencies", "network-access"] as const;

/** Built-in system safety layer: highest precedence, cannot be weakened. */
export const SYSTEM_POLICY: PolicyLayer = {
  destructiveCommands: "deny",
  requireApprovalFor: ["install-dependencies"],
  nonWaivable: [...SECURITY_POLICY_IDS],
};

export const ORG_POLICY_FILE = ".brokkr/org-policy.yaml";
export const EXCEPTIONS_FILE = ".brokkr/exceptions.yaml";

export interface PolicyLayerInput {
  layer: PolicyLayerName;
  policy: PolicyLayer;
}

/** Result of merging all layers. */
export interface EffectivePolicy {
  network: AllowDeny;
  destructiveCommands: AllowDeny;
  /** Every list must match argv[0]. */
  allowedCommands: Array<{ layer: PolicyLayerName; globs: string[] }>;
  requireApprovalFor: string[];
  requiredCheckIds: string[];
  reviewRequired: boolean;
  waivable: string[];
  nonWaivable: string[];
  /** Check ids allowed to use the network despite a deny (organization/project only). */
  allowNetworkFor: Array<{ id: string; layer: PolicyLayerName }>;
  /** Layer that set each restrictive value. */
  provenance: Partial<
    Record<"network" | "destructiveCommands" | "reviewRequired", PolicyLayerName>
  >;
  /** Attempts by lower layers to weaken a higher-layer restriction, and other notes. */
  warnings: string[];
  /**
   * Attempts by a layer to make waivable a check that a higher-precedence layer
   * requires. Unlike `warnings`, each conflict blocks the run (fix round 2, I2).
   */
  conflicts: string[];
}

function union(into: string[], values: readonly string[] | undefined): void {
  for (const v of values ?? []) if (!into.includes(v)) into.push(v);
}

/**
 * Merge policy layers in precedence order (system → organization → project →
 * harness → task). A lower layer may strengthen but never weaken: `deny`
 * beats `allow`, requirements are unioned, allowlists intersect.
 */
export function mergePolicies(layers: readonly PolicyLayerInput[]): EffectivePolicy {
  const out: EffectivePolicy = {
    network: "allow",
    destructiveCommands: "allow",
    allowedCommands: [],
    requireApprovalFor: [],
    requiredCheckIds: [],
    reviewRequired: false,
    waivable: [],
    nonWaivable: [],
    allowNetworkFor: [],
    provenance: {},
    warnings: [],
    conflicts: [],
  };
  const waivableRequests: Array<{ id: string; layer: PolicyLayerName }> = [];
  /** check id → highest-precedence layer whose requiredCheckIds lists it */
  const requiredAt = new Map<string, PolicyLayerName>();
  const networkRequests: Array<{ id: string; layer: PolicyLayerName }> = [];
  let organizationDeniesNetwork = false;
  let organizationRequiresNetworkApproval = false;

  for (const { layer, policy } of layers) {
    for (const key of ["network", "destructiveCommands"] as const) {
      const value = policy[key];
      if (value === undefined) continue;
      if (value === "deny" && out[key] === "allow") {
        out[key] = "deny";
        out.provenance[key] = layer;
      } else if (value === "allow" && out[key] === "deny") {
        out.warnings.push(
          `${layer} policy tried to set ${key}: allow over deny from ${out.provenance[key]}; ignored`,
        );
      }
    }
    if (policy.reviewRequired === true && !out.reviewRequired) {
      out.reviewRequired = true;
      out.provenance.reviewRequired = layer;
    } else if (policy.reviewRequired === false && out.reviewRequired) {
      out.warnings.push(
        `${layer} policy tried to set reviewRequired: false over ${out.provenance.reviewRequired}; ignored`,
      );
    }
    if (policy.allowedCommands) out.allowedCommands.push({ layer, globs: policy.allowedCommands });
    union(out.requireApprovalFor, policy.requireApprovalFor);
    union(out.requiredCheckIds, policy.requiredCheckIds);
    for (const id of policy.requiredCheckIds ?? [])
      if (
        !requiredAt.has(id) ||
        POLICY_LAYERS.indexOf(layer) < POLICY_LAYERS.indexOf(requiredAt.get(id)!)
      )
        requiredAt.set(id, layer);
    union(out.nonWaivable, policy.nonWaivable);
    if (layer === "organization" && policy.network === "deny") organizationDeniesNetwork = true;
    if (layer === "organization" && policy.requireApprovalFor?.includes("network-access"))
      organizationRequiresNetworkApproval = true;
    for (const id of policy.allowNetworkFor ?? []) {
      if (layer === "organization" || layer === "project") networkRequests.push({ id, layer });
      else out.warnings.push(`${layer} policy may not set allowNetworkFor ('${id}'); ignored`);
    }
    for (const id of policy.waivable ?? []) {
      // Marking something waivable weakens policy: the task layer (lowest precedence,
      // supplied by the planner) may not do it.
      if (layer === "task") out.warnings.push(`task policy may not mark '${id}' waivable; ignored`);
      else waivableRequests.push({ id, layer });
    }
  }

  const rank = (l: PolicyLayerName): number => POLICY_LAYERS.indexOf(l);
  for (const { id, layer } of waivableRequests) {
    // A layer may make waivable only checks required at its own or a lower layer.
    const checkId = id.startsWith("check:") ? id.slice("check:".length) : undefined;
    const requiredBy = checkId !== undefined ? requiredAt.get(checkId) : undefined;
    if (requiredBy !== undefined && rank(requiredBy) < rank(layer)) {
      out.conflicts.push(
        `${layer} policy may not make '${id}' waivable: it is required by ${requiredBy} policy`,
      );
      continue;
    }
    if (out.nonWaivable.includes(id)) {
      out.warnings.push(`${layer} policy marks '${id}' waivable, but it is not waivable; ignored`);
    } else if (!out.waivable.includes(id)) out.waivable.push(id);
  }
  for (const req of networkRequests) {
    if (organizationRequiresNetworkApproval)
      out.warnings.push(
        `allowNetworkFor '${req.id}' from ${req.layer} ignored: the organization requires approval for network-access (use a check-bound approval)`,
      );
    else if (organizationDeniesNetwork)
      out.warnings.push(
        `allowNetworkFor '${req.id}' from ${req.layer} ignored: organization denies network`,
      );
    else if (out.nonWaivable.includes("network-access"))
      out.warnings.push(
        `allowNetworkFor '${req.id}' from ${req.layer} ignored: network-access is non-waivable`,
      );
    else if (!out.allowNetworkFor.some((a) => a.id === req.id)) out.allowNetworkFor.push(req);
  }
  return out;
}

/** Harness policy layer from a composed harness plus its checks' `waivable` flags. */
export function harnessLayer(
  policies: Policies,
  checks: ReadonlyArray<{ id: string; waivable?: boolean | undefined }>,
): PolicyLayer {
  const waivable = checks.filter((c) => c.waivable === true).map((c) => `check:${c.id}`);
  return {
    network: policies.network,
    destructiveCommands: policies.destructiveCommands,
    requireApprovalFor: [...policies.requireApprovalFor],
    ...(waivable.length > 0 ? { waivable } : {}),
  };
}

/** A check as planned for execution (after composition, before running). */
export interface PlannedCheck {
  id: string;
  command: string[];
  /** Working directory relative to the workspace. */
  cwd: string;
  required: boolean;
  /** `policy` when a `requiredCheckIds` policy requires the check. */
  requiredBy?: "harness" | "policy";
  timeoutSeconds: number;
  /** `name@version` of the declaring harnesses. */
  from: string[];
  waivable?: boolean;
}

export interface VerificationPlan {
  checks: PlannedCheck[];
  /** `name@version` (and source) of harnesses that are not allowed to execute. */
  untrustedHarnesses: string[];
}

export interface EvaluationContext {
  projectId?: string;
  taskId?: string;
  /** `name@version` of every harness in the run, recorded with applied exceptions. */
  harnesses: string[];
  now: Date;
}

export interface BeforeEvaluation {
  decisions: PolicyDecision[];
  /** Run-level blocking reasons; non-empty means no check may execute. */
  blocked: string[];
  /** Check id → denial message. */
  denied: Map<string, string>;
  /** Check id → exception id for checks waived by an approved exception. */
  waived: Map<string, string>;
  /** Check ids that need the network while network is denied and no approval exists. */
  networkDenied: Map<string, string>;
  /** Check ids that were granted network access by an approval exception. */
  networkApproved: Set<string>;
  applied: AppliedException[];
  warnings: string[];
}

function inScope(e: ApprovedException, ctx: EvaluationContext): boolean {
  if (e.scope.task !== undefined && e.scope.task !== ctx.taskId) return false;
  if (e.scope.project !== undefined && e.scope.project !== ctx.projectId) return false;
  return true;
}

/** Valid exceptions (unexpired, in scope), with warnings for the rest. */
function usableExceptions(
  exceptions: readonly ApprovedException[],
  ctx: EvaluationContext,
  warnings: string[],
  decisions: PolicyDecision[],
  stage: PolicyDecision["stage"],
): ApprovedException[] {
  const usable: ApprovedException[] = [];
  for (const e of exceptions) {
    let problem: string | undefined;
    if (Date.parse(e.expiresAt) <= ctx.now.getTime()) problem = `expired at ${e.expiresAt}`;
    else if (Date.parse(e.approvedAt) > ctx.now.getTime())
      problem = `approved in the future (${e.approvedAt})`;
    else if (!inScope(e, ctx)) problem = "out of scope for this project/task";
    if (problem) {
      const message = `exception ${e.id} (${e.policy}) ignored: ${problem}`;
      if (stage === "before") warnings.push(message);
      decisions.push({
        policy: e.policy,
        stage,
        outcome: "warn",
        layer: "project",
        exceptionId: e.id,
        message,
      });
      continue;
    }
    usable.push(e);
  }
  return usable;
}

function applied(e: ApprovedException, ctx: EvaluationContext, checkId?: string): AppliedException {
  return {
    ...e,
    appliedTo: {
      ...(ctx.taskId !== undefined ? { task: ctx.taskId } : {}),
      harnesses: [...ctx.harnesses],
      ...(checkId !== undefined ? { checkId } : {}),
    },
  };
}

function isWaivable(policy: EffectivePolicy, id: string): boolean {
  return policy.waivable.includes(id) && !policy.nonWaivable.includes(id);
}

/** Stage 1 (spec §9.4): decide whether the requested commands and permissions are allowed. */
export function evaluateBefore(
  plan: VerificationPlan,
  policy: EffectivePolicy,
  exceptions: readonly ApprovedException[],
  ctx: EvaluationContext,
): BeforeEvaluation {
  const result: BeforeEvaluation = {
    decisions: [],
    blocked: [],
    denied: new Map(),
    waived: new Map(),
    networkDenied: new Map(),
    networkApproved: new Set(),
    applied: [],
    warnings: [...policy.warnings],
  };
  const usable = usableExceptions(exceptions, ctx, result.warnings, result.decisions, "before");
  const appliedIds = new Set<string>();
  const apply = (e: ApprovedException, checkId?: string): void => {
    if (appliedIds.has(`${e.id}:${checkId ?? ""}`)) return;
    appliedIds.add(`${e.id}:${checkId ?? ""}`);
    result.applied.push(applied(e, ctx, checkId));
  };
  const approvalFor = (id: string): ApprovedException | undefined =>
    usable.find((e) => e.policy === id);

  for (const e of usable) {
    const isApproval = (APPROVAL_POLICY_IDS as readonly string[]).some(
      (id) => e.policy === id || e.policy.startsWith(`${id}:`),
    );
    if (e.policy === "network-access" && e.scope.checkId === undefined) {
      const message = `exception ${e.id} (network-access) ignored: it must name a check (policy network-access:<checkId> or scope.checkId)`;
      result.warnings.push(message);
      result.decisions.push({
        policy: e.policy,
        stage: "before",
        outcome: "warn",
        layer: "system",
        exceptionId: e.id,
        message,
      });
      continue;
    }
    if (!isApproval && !isWaivable(policy, e.policy)) {
      const message = `exception ${e.id} ignored: policy '${e.policy}' is not waivable`;
      result.warnings.push(message);
      result.decisions.push({
        policy: e.policy,
        stage: "before",
        outcome: "warn",
        layer: "system",
        exceptionId: e.id,
        message,
      });
    }
  }

  for (const a of policy.allowNetworkFor) {
    if (!plan.checks.some((c) => c.id === a.id))
      result.warnings.push(`${a.layer} policy allowNetworkFor lists '${a.id}': no such check`);
  }

  for (const conflict of policy.conflicts) {
    result.blocked.push(`policy_conflict: ${conflict}`);
    result.decisions.push({
      policy: "policy-conflict",
      stage: "before",
      outcome: "deny",
      layer: conflict.split(" ")[0] as PolicyLayerName,
      message: conflict,
    });
  }

  if (plan.untrustedHarnesses.length > 0) {
    const refs = plan.untrustedHarnesses.join(", ");
    result.blocked.push(`untrusted_source: ${refs}`);
    result.decisions.push({
      policy: "untrusted-source",
      stage: "before",
      outcome: "deny",
      layer: "system",
      message: `harness ${refs} comes from an untrusted source; run \`brokkr trust add\` after reviewing it`,
    });
  }

  const deny = (
    checkId: string,
    policyId: string,
    layer: PolicyLayerName,
    message: string,
  ): void => {
    result.denied.set(checkId, message);
    result.blocked.push(`${policyId}: ${message}`);
    result.decisions.push({
      policy: policyId,
      stage: "before",
      outcome: "deny",
      layer,
      checkId,
      message,
    });
  };

  for (const check of plan.checks) {
    const waiverId = `check:${check.id}`;
    if (isWaivable(policy, waiverId)) {
      const exception = usable.find((e) => e.policy === waiverId);
      if (exception) {
        result.waived.set(check.id, exception.id);
        apply(exception, check.id);
        result.decisions.push({
          policy: waiverId,
          stage: "before",
          outcome: "waived",
          layer: "project",
          checkId: check.id,
          exceptionId: exception.id,
          message: `check '${check.id}' waived by exception ${exception.id}: ${exception.reason}`,
        });
        continue;
      }
    }

    if (check.cwd !== "." && !isSafeRelativePath(check.cwd)) {
      deny(
        check.id,
        "filesystem",
        "system",
        `check '${check.id}' cwd '${check.cwd}' escapes the workspace`,
      );
      continue;
    }
    const analysis = analyzeCommand(check.command);
    if (analysis.destructive && policy.destructiveCommands === "deny") {
      deny(
        check.id,
        "destructive-commands",
        policy.provenance.destructiveCommands ?? "system",
        `check '${check.id}' runs a destructive operation (${analysis.destructive})`,
      );
      continue;
    }
    const argv0 = check.command[0] ?? "";
    const failedList = policy.allowedCommands.find(
      (list) => !list.globs.some((g) => globToRegExp(g).test(argv0)),
    );
    if (failedList) {
      deny(
        check.id,
        "command-allowlist",
        failedList.layer,
        `check '${check.id}' executable '${argv0}' is not in the ${failedList.layer} allowedCommands list`,
      );
      continue;
    }
    if (analysis.dependencyInstall && policy.requireApprovalFor.includes("install-dependencies")) {
      const approval = approvalFor("install-dependencies");
      if (!approval) {
        const message = `check '${check.id}' installs dependencies and requires approval (exception for policy install-dependencies)`;
        result.denied.set(check.id, message);
        result.blocked.push(`install-dependencies: ${message}`);
        result.decisions.push({
          policy: "install-dependencies",
          stage: "before",
          outcome: "require_approval",
          layer: "system",
          checkId: check.id,
          message,
        });
        continue;
      }
      apply(approval, check.id);
      result.decisions.push({
        policy: "install-dependencies",
        stage: "before",
        outcome: "approved",
        layer: "project",
        checkId: check.id,
        exceptionId: approval.id,
        message: `dependency installation approved by ${approval.approvedBy} (${approval.id})`,
      });
    }
    if (analysis.needsNetwork && policy.network === "deny") {
      const allowed = policy.allowNetworkFor.find((a) => a.id === check.id);
      const approval = allowed
        ? undefined
        : usable.find(
            (e) =>
              e.policy === `network-access:${check.id}` ||
              (e.policy === "network-access" && e.scope.checkId === check.id),
          );
      if (allowed) {
        result.networkApproved.add(check.id);
        result.decisions.push({
          policy: "network-access",
          stage: "before",
          outcome: "approved",
          layer: allowed.layer,
          checkId: check.id,
          message: `network allowed for '${check.id}' by ${allowed.layer} policy allowNetworkFor`,
        });
      } else if (approval) {
        result.networkApproved.add(check.id);
        apply(approval, check.id);
        result.decisions.push({
          policy: "network-access",
          stage: "before",
          outcome: "approved",
          layer: "project",
          checkId: check.id,
          exceptionId: approval.id,
          message: `network access for '${check.id}' approved by ${approval.approvedBy} (${approval.id})`,
        });
      } else {
        const message = `check '${check.id}' needs network access but network is denied by ${policy.provenance.network} policy; allow it with project allowNetworkFor or an exception for policy network-access:${check.id}`;
        result.networkDenied.set(check.id, message);
        result.decisions.push({
          policy: "network",
          stage: "before",
          outcome: "deny",
          layer: policy.provenance.network ?? "system",
          checkId: check.id,
          message,
        });
        continue;
      }
    }
    result.decisions.push({
      policy: "command",
      stage: "before",
      outcome: "allow",
      layer: "system",
      checkId: check.id,
      message: `check '${check.id}' permitted: ${check.command.join(" ")}`,
    });
  }

  result.decisions.push({
    policy: "network",
    stage: "runtime",
    outcome: policy.network === "deny" ? "deny" : "allow",
    layer: policy.provenance.network ?? "system",
    message:
      policy.network === "deny"
        ? "network denied: proxy variables point at an unreachable loopback (best effort, not an OS sandbox)"
        : "network allowed",
  });
  return result;
}

/** Unreachable loopback proxy used to make well-behaved tools fail fast when network is denied. */
export const NETWORK_DENY_PROXY = "http://127.0.0.1:9";
const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];
const BYPASS_VARS = ["NO_PROXY", "no_proxy"];

/**
 * Runtime hook for the network policy. Inherited proxy settings are always
 * stripped; `deny` points every proxy variable at an unreachable loopback.
 * This is best effort: a process that ignores proxy variables can still
 * reach the network without an OS sandbox (ADR-004).
 */
export function applyNetworkPolicy(
  network: AllowDeny,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (PROXY_VARS.includes(k) || BYPASS_VARS.includes(k)) continue;
    out[k] = v;
  }
  if (network === "deny") {
    for (const k of PROXY_VARS) out[k] = NETWORK_DENY_PROXY;
    // Make package managers fail fast instead of retrying against the dead proxy.
    out.npm_config_offline = "true";
    out.pnpm_config_offline = "true";
    out.YARN_ENABLE_OFFLINE_MODE = "1";
  }
  return out;
}

export interface AfterInput {
  exceptions: readonly ApprovedException[];
  ctx: EvaluationContext;
  /** Secret findings in generated instruction bundles. */
  bundleFindings?: ReadonlyArray<{ file: string; findings: number }>;
  /** True when a review result was recorded for this run. */
  reviewRecorded?: boolean;
}

export interface AfterEvaluation {
  decisions: PolicyDecision[];
  blocked: string[];
  unmet: string[];
  applied: AppliedException[];
}

/** Stage 3 (spec §9.4): required checks, review, secret exposure and exceptions. */
export function evaluateAfter(
  results: readonly CheckResult[],
  policy: EffectivePolicy,
  input: AfterInput,
): AfterEvaluation {
  const out: AfterEvaluation = { decisions: [], blocked: [], unmet: [], applied: [] };
  const usable = usableExceptions(input.exceptions, input.ctx, [], [], "after");

  for (const r of results) {
    if ((r.secretFindings ?? 0) > 0) {
      const message = `${r.secretFindings} secret(s) in output of '${r.id}' (redacted)`;
      out.blocked.push(`secret_exposure: ${message}`);
      out.decisions.push({
        policy: "secret-exposure",
        stage: "after",
        outcome: "deny",
        layer: "system",
        checkId: r.id,
        message,
      });
    }
  }
  for (const f of input.bundleFindings ?? []) {
    const message = `${f.findings} secret(s) in generated bundle file ${f.file}`;
    out.blocked.push(`secret_exposure: ${message}`);
    out.decisions.push({
      policy: "secret-exposure",
      stage: "after",
      outcome: "deny",
      layer: "system",
      message,
    });
  }

  const waive = (policyId: string, unmet: string): void => {
    const exception = isWaivable(policy, policyId)
      ? usable.find((e) => e.policy === policyId)
      : undefined;
    if (exception) {
      out.applied.push(applied(exception, input.ctx));
      out.decisions.push({
        policy: policyId,
        stage: "after",
        outcome: "waived",
        layer: "project",
        exceptionId: exception.id,
        message: `${unmet}; waived by exception ${exception.id}`,
      });
      return;
    }
    out.unmet.push(unmet);
    out.decisions.push({
      policy: policyId,
      stage: "after",
      outcome: "unmet",
      layer: "project",
      message: unmet,
    });
  };

  const ids = new Set(results.map((r) => r.id));
  for (const id of policy.requiredCheckIds) {
    if (!ids.has(id))
      waive(`check:${id}`, `required check '${id}' is not defined by any selected harness`);
  }
  if (policy.reviewRequired && !input.reviewRecorded) {
    waive(
      "review",
      `review required by ${policy.provenance.reviewRequired} policy but no review result was recorded`,
    );
  }
  return out;
}

async function loadYaml<T>(
  file: string,
  label: string,
  schema: Parameters<typeof parseManifestText>[1],
): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  const parsed = parseManifestText(await readFile(file, "utf8"), schema, label);
  if (!parsed.ok) {
    throw new BrokkrError("invalid-config", `invalid ${label}:\n${formatIssues(parsed.issues)}`, {
      details: { issues: parsed.issues },
    });
  }
  return parsed.value as T;
}

/** Organization layer from `<home>/.brokkr/org-policy.yaml` (optional). */
export async function loadOrgPolicy(homeDir: string): Promise<PolicyLayer | undefined> {
  return loadYaml<PolicyLayer>(join(homeDir, ORG_POLICY_FILE), ORG_POLICY_FILE, PolicyLayerSchema);
}

/** Approval exceptions from `<cwd>/.brokkr/exceptions.yaml` (optional). */
export async function loadExceptions(cwd: string): Promise<ApprovedException[]> {
  const file = await loadYaml<{ exceptions: ApprovedException[] }>(
    join(cwd, EXCEPTIONS_FILE),
    EXCEPTIONS_FILE,
    ExceptionsFileSchema,
  );
  return file?.exceptions ?? [];
}

/** Approval exceptions from an explicit file (e.g. supplied by Mimir from outside the worktree). */
export async function loadExceptionsFile(file: string): Promise<ApprovedException[]> {
  if (!existsSync(file))
    throw new BrokkrError("invalid-config", `exceptions file ${file} does not exist`);
  const loaded = await loadYaml<{ exceptions: ApprovedException[] }>(
    file,
    file,
    ExceptionsFileSchema,
  );
  return loaded?.exceptions ?? [];
}

/** A policy layer from an explicit file (`--policy`). */
export async function loadPolicyFile(file: string): Promise<PolicyLayer> {
  if (!existsSync(file))
    throw new BrokkrError("invalid-config", `policy file ${file} does not exist`);
  return (await loadYaml<PolicyLayer>(file, file, PolicyLayerSchema))!;
}

/** A usable (unexpired, in-scope) approval exception for `policyId`, if any. */
export function findApproval(
  exceptions: readonly ApprovedException[],
  policyId: string,
  ctx: EvaluationContext,
): ApprovedException | undefined {
  return usableExceptions(exceptions, ctx, [], [], "before").find((e) => e.policy === policyId);
}
