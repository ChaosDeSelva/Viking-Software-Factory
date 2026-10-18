import { PolicyIdSchema, type EventPayloadMap } from "@mimir/protocol";
import type { PrivilegedAction } from "./actions.js";
import type { PolicyDecision } from "./evaluate.js";

export const POLICY_EVENT_TYPES = [
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "policy.denied",
] as const;
export type PolicyEventType = (typeof POLICY_EVENT_TYPES)[number];

/**
 * A domain event as a plain object. The caller wraps it in an envelope and appends it to the
 * event log; payloads conform to the protocol's payload schema for `type`.
 */
export type PolicyDomainEvent = {
  [K in PolicyEventType]: { type: K; payload: EventPayloadMap[K] };
}[PolicyEventType];

export type PolicyDomainEventOf<K extends PolicyEventType> = Extract<
  PolicyDomainEvent,
  { type: K }
>;

/**
 * Build a `policy.denied` event for a decision. When the matched rule came from
 * `rulesFromPolicy` (id `pol_...#n`), the policy id is included.
 */
export function policyDeniedEvent(
  action: PrivilegedAction,
  decision: PolicyDecision,
): PolicyDomainEventOf<"policy.denied"> {
  const payload: EventPayloadMap["policy.denied"] = { action, reason: decision.reason };
  const candidate = decision.ruleId?.split("#")[0];
  const parsed = PolicyIdSchema.safeParse(candidate);
  if (parsed.success) payload.policyId = parsed.data;
  return { type: "policy.denied", payload };
}
