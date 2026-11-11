// The Raise budget form's decisions, free of React so node --test covers them: which Mimir budget
// blocks a task, whether a change can be proposed, and the `budget.raise` body it sends.
import type { R } from "../lib/api";

/** Mimir's `BudgetOnUnknownSchema`: dispatch or hold when usage cannot be measured. */
export const ON_UNKNOWN = ["allow", "block"] as const;
export type OnUnknown = (typeof ON_UNKNOWN)[number];
export type BudgetScope = "crew" | "mission";

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The attention entry for the budget that holds the task: an exhausted crew or mission budget
 * (crew first; a second exhausted one re-blocks and shows up next), or for `budget_uncertain` one
 * whose usage is unknown. Warnings never qualify: raising one would not release the task.
 * Undefined means nothing is known, and the form asks for the scope.
 */
export function budgetEntryFor(items: R[], task: R): R | undefined {
  const mine = items.filter(
    (i) =>
      String(i.kind).startsWith("budget_") &&
      ((i.crewId && i.crewId === task.crewId) ||
        (!i.crewId && i.missionId === task.missionId)),
  );
  const exceeded = mine.filter((i) => i.kind === "budget_exceeded");
  return (
    exceeded.find((i) => i.crewId) ??
    exceeded[0] ??
    (task.blockedReason === "budget_uncertain"
      ? mine.find((i) => i.uncertain === true)
      : undefined)
  );
}

/** The scope a known entry belongs to; null when the operator must choose. */
export const entryScope = (entry: R | undefined): BudgetScope | null =>
  entry ? (entry.crewId ? "crew" : "mission") : null;

/** The crew or mission ID `budget.raise` targets for that scope. */
export const budgetTarget = (
  task: R,
  scope: BudgetScope,
  entry: R | undefined,
): string | undefined =>
  (scope === "mission"
    ? (entry?.missionId ?? task.missionId)
    : (entry?.crewId ?? task.crewId)) || undefined;

/** Why the change cannot be proposed yet; empty when it can. */
export function budgetBlock(
  operator: boolean,
  target: string | undefined,
  tokens: string,
  cost: string,
  entry: R | undefined,
  onUnknown: OnUnknown | "" = "",
): string {
  if (!operator) return "Unlock operator controls under Connections first.";
  if (!target)
    return "This task has no crew or mission in Mimir's snapshot, so there is no budget to change.";
  const t = tokens.trim() ? Number(tokens) : null,
    c = cost.trim() ? Number(cost) : null;
  if (t === null && c === null && !onUnknown)
    return "Enter a new token or cost limit, or choose how to treat unknown usage.";
  if (t !== null && (!Number.isInteger(t) || t <= 0))
    return "The token limit must be a whole number above 0.";
  // Infinity would reach the server as JSON null and the new limit would be silently dropped.
  if (c !== null && !(Number.isFinite(c) && c > 0))
    return "The cost limit must be a number above 0.";
  const limitTokens = num(entry?.limitTokens),
    limitCost = num(entry?.limitCost);
  if (t !== null && limitTokens !== null && t <= limitTokens)
    return "The new token limit must be higher than the current one.";
  if (c !== null && limitCost !== null && c <= limitCost)
    return "The new cost limit must be higher than the current one.";
  return "";
}

/** The `budget.raise` body: only what the operator set, plus the version Mimir reported. */
export function budgetPayload(
  scope: BudgetScope,
  tokens: string,
  cost: string,
  onUnknown: OnUnknown | "",
  entry: R | undefined,
): R {
  const version = num(entry?.budgetVersion);
  return {
    scope,
    ...(tokens.trim() ? { limitTokens: Number(tokens) } : {}),
    ...(cost.trim() ? { limitCost: Number(cost) } : {}),
    ...(onUnknown ? { onUnknown } : {}),
    ...(version !== null ? { expectedVersion: version } : {}),
  };
}
