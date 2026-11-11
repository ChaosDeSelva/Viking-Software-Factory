/**
 * Plain words for a task's `blockedReason`. Sources: the parking reasons in
 * `packages/core/src/domain/taskMachine.ts` (budget, dispatch policy, restart recovery), and the
 * runtime's `runtimeStatus` copied in on `runtime_blocked` (`apps/server/src/orchestrator`,
 * `terminal-runtime/{hooks,acp-client}.ts`, `packages/herdr-adapter`), or the event type when
 * that was empty. Runtimes may send anything else: unknown values come back raw, never hidden.
 */

export interface BlockedReasonText {
  /** What to show. The raw value itself when unknown. */
  words: string;
  /** The value exactly as received, for the tooltip. */
  raw: string;
  known: boolean;
}

const REASONS: Readonly<Record<string, string>> = {
  budget_exceeded: "Budget used up",
  budget_uncertain: "Budget usage unknown",
  approval_required: "Waiting for approval to start",
  policy_denied: "Denied by policy",
  unknown_after_restart: "Session lost in a restart",
  "blocked:trust_prompt": "Waiting for folder-trust approval",
  blocked: "Agent reported blocked",
  harness_error: "Agent harness error",
  harness_quota_wait: "Waiting for usage quota",
  runtime_blocked: "Agent reported blocked",
  approval_needed: "Agent needs approval",
};

export function describeBlockedReason(reason: string | null | undefined): BlockedReasonText {
  const raw = reason ?? "";
  const words = Object.hasOwn(REASONS, raw) ? REASONS[raw] : undefined;
  return words === undefined ? { words: raw, raw, known: false } : { words, raw, known: true };
}
