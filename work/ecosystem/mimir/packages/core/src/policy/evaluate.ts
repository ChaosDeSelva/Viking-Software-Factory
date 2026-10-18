import { MimirError, type CrewRole, type Policy, type PolicyEffect } from "@mimir/protocol";
import { DEFAULT_EFFECTS, isPrivilegedAction, type PrivilegedAction } from "./actions.js";

export type ActorKind = "agent" | "human" | "system";

export interface Actor {
  kind: ActorKind;
  id: string;
  crewId?: string;
  role?: CrewRole | string;
}

export interface PolicyScope {
  projectId?: string;
  crewId?: string;
  role?: string;
}

export interface PolicyRule {
  id: string;
  action: PrivilegedAction;
  effect: PolicyEffect;
  scope?: PolicyScope;
  /** ISO-8601. The rule stops applying at this instant. */
  expiresAt?: string;
}

export interface EvaluationRequest {
  action: PrivilegedAction;
  /**
   * The caller must build `actor` (especially `role` and `crewId`) from trusted records such as
   * the crew member row, never from data an agent supplied: scope matching trusts these fields.
   */
  actor: Actor;
  projectId?: string | undefined;
  /**
   * Free-form context for audit and display only. Evaluation never reads it, so text an agent
   * picked up from untrusted input (e.g. `context.untrustedText`) cannot change the decision.
   */
  context?: Record<string, unknown>;
  /** Clock used for rule expiry. Defaults to the current time. */
  now?: Date;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleId?: string;
  reason: string;
}

/** An unparseable expiry counts as expired, so a malformed time-boxed rule never becomes permanent. */
function isExpired(expiresAt: string, now: number): boolean {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= now;
}

/** Tie-break order: higher wins. */
const EFFECT_RANK: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, deny: 2 };

function scopeMatches(scope: PolicyScope | undefined, request: EvaluationRequest): number {
  if (!scope) return 0;
  const wanted: Array<[string | undefined, string | undefined]> = [
    [scope.projectId, request.projectId],
    [scope.crewId, request.actor.crewId],
    [scope.role, request.actor.role],
  ];
  let specificity = 0;
  for (const [want, have] of wanted) {
    if (want === undefined) continue;
    if (want !== have) return -1;
    specificity += 1;
  }
  return specificity;
}

function describeScope(scope: PolicyScope | undefined): string {
  const parts = Object.entries(scope ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? `scope ${parts.join(", ")}` : "global scope";
}

/**
 * Decide whether `request` may proceed. Pure.
 *
 * Only rules for the requested action that have not expired and whose scope matches are considered.
 * The most specific scope wins (count of scope fields set); among equally specific rules
 * `deny` > `require_approval` > `allow`. With no match the action's default applies (deny, or
 * require_approval for `runtime.accept_trust_prompt`). Human actors get no implicit bypass.
 */
export function evaluate(
  policies: readonly PolicyRule[],
  request: EvaluationRequest,
): PolicyDecision {
  if (!isPrivilegedAction(request.action)) {
    throw new MimirError("validation_failed", `unknown privileged action: ${request.action}`, {
      action: request.action,
    });
  }
  const now = (request.now ?? new Date()).getTime();

  let best: { rule: PolicyRule; specificity: number } | undefined;
  for (const rule of policies) {
    if (rule.action !== request.action) continue;
    if (rule.expiresAt !== undefined && isExpired(rule.expiresAt, now)) continue;
    const specificity = scopeMatches(rule.scope, request);
    if (specificity < 0) continue;
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && EFFECT_RANK[rule.effect] > EFFECT_RANK[best.rule.effect])
    ) {
      best = { rule, specificity };
    }
  }

  if (!best) {
    const effect = DEFAULT_EFFECTS[request.action];
    return {
      effect,
      reason: `no policy rule matches ${request.action}; default is ${effect}`,
    };
  }
  const { rule } = best;
  return {
    effect: rule.effect,
    ruleId: rule.id,
    reason: `rule ${rule.id} (${describeScope(rule.scope)}) sets ${request.action} to ${rule.effect}`,
  };
}

/**
 * Convert a stored protocol `Policy` into evaluable rules. Rule ids are `${policy.id}#${index}`.
 * Rules for actions that are not privileged are dropped (they can never match a request).
 */
export function rulesFromPolicy(policy: Policy): PolicyRule[] {
  const out: PolicyRule[] = [];
  policy.rules.forEach((r, i) => {
    if (!isPrivilegedAction(r.action)) return;
    const rule: PolicyRule = { id: `${policy.id}#${i}`, action: r.action, effect: r.effect };
    if (policy.projectId !== null) rule.scope = { projectId: policy.projectId };
    out.push(rule);
  });
  return out;
}
