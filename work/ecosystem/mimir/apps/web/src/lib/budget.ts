/**
 * Pure logic behind "Raise budget": which budget blocked a task, its current limits and version
 * (rebuilt from the mission's events, since the snapshot carries no budgets) and a suggested limit.
 */
import type { BudgetPolicy, Crew, EventEnvelope, EventPayloadMap, Task } from "@mimir/protocol";

export type BudgetOnUnknown = NonNullable<BudgetPolicy["onUnknown"]>;

/** The event types the dialog replays for one mission. */
export const BUDGET_EVENT_TYPES = [
  "crew.created",
  "mission.created",
  "budget.updated",
  "budget.exceeded",
] as const;

export type BudgetTarget = { kind: "crew"; crewId: string } | { kind: "mission" };

export const targetKey = (t: BudgetTarget) => (t.kind === "crew" ? `crew:${t.crewId}` : "mission");

export interface ExceededFact {
  budgetId: string;
  crewId: string | null;
  scope: "crew" | "mission" | "project";
  unit: "tokens" | "cost";
  used: number;
  limit: number;
  at: string;
}

/**
 * Newest `budget.exceeded` of the events (crew from the envelope; no crew means mission scope)
 * whose budget has not been changed since: the server reports a changed budget again if its new
 * limits are reached, so an older report names a budget that may no longer hold anything.
 */
export function latestExceeded(events: readonly EventEnvelope[]): ExceededFact | null {
  // The newest update of each budget after the report; walked newest first, so the first seen wins.
  const updatedSince = new Map<string, EventPayloadMap["budget.updated"]["budget"]>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "budget.updated") {
      const b = (e.payload as EventPayloadMap["budget.updated"]).budget;
      if (!updatedSince.has(b.id)) updatedSince.set(b.id, b);
      continue;
    }
    if (e.type !== "budget.exceeded") continue;
    const p = e.payload as EventPayloadMap["budget.exceeded"];
    // Skip it only if a later update lifted the exhausted limit above what was used; an update
    // that changed something else (e.g. onUnknown) leaves the budget exhausted.
    const later = updatedSince.get(p.budgetId);
    if (later) {
      const limit = p.unit === "cost" ? later.limitCost : later.limitTokens;
      if (limit === null || limit > p.used) continue;
    }
    const crewId = e.crewId ?? null;
    return {
      budgetId: p.budgetId,
      crewId,
      scope: p.scope ?? (crewId ? "crew" : "mission"),
      unit: p.unit,
      used: p.used,
      limit: p.limit,
      at: e.occurredAt,
    };
  }
  return null;
}

/**
 * The target's budget as it stands after `events` (oldest first): the creation budget, then each
 * `budget.updated` that replaces it. null: no budget seen for it.
 */
export function currentPolicy(
  events: readonly EventEnvelope[],
  target: BudgetTarget,
): BudgetPolicy | null {
  let policy: BudgetPolicy | null = null;
  for (const e of events) {
    if (e.type === "crew.created" && target.kind === "crew") {
      const p = e.payload as EventPayloadMap["crew.created"];
      if (p.crew.id === target.crewId && p.budget) policy = p.budget;
    } else if (e.type === "mission.created" && target.kind === "mission") {
      const p = e.payload as EventPayloadMap["mission.created"];
      if (p.budget) policy = p.budget;
    } else if (e.type === "budget.updated") {
      const b = (e.payload as EventPayloadMap["budget.updated"]).budget;
      const matches = target.kind === "crew" ? b.crewId === target.crewId : b.crewId === null;
      if (matches) policy = b;
    }
  }
  return policy;
}

/**
 * Crews that could run the task (its own crew, else every crew of its mission), plus the mission
 * budget when it ran out or exists, and the target to preselect: the budget the newest exceeded
 * event names, else the first one `holds` (an unknown-usage block names none: the budget that
 * blocks unknown usage), else the first one `hasBudget`, else the first.
 */
export function budgetTargets(
  task: Pick<Task, "crewId"> | undefined,
  missionCrews: readonly Crew[],
  exceeded: ExceededFact | null,
  hasBudget: (t: BudgetTarget) => boolean = () => false,
  holds: (t: BudgetTarget) => boolean = () => false,
): { targets: BudgetTarget[]; preferred: BudgetTarget | null } {
  const crews =
    task?.crewId != null ? missionCrews.filter((c) => c.id === task.crewId) : [...missionCrews];
  const targets: BudgetTarget[] = crews.map((c) => ({ kind: "crew", crewId: c.id }));
  const missionScoped =
    exceeded !== null && exceeded.crewId === null && exceeded.scope === "mission";
  if (missionScoped || hasBudget({ kind: "mission" })) targets.push({ kind: "mission" });
  const preferred: BudgetTarget | null =
    exceeded?.crewId && crews.some((c) => c.id === exceeded.crewId)
      ? { kind: "crew", crewId: exceeded.crewId }
      : missionScoped
        ? { kind: "mission" }
        : (targets.find(holds) ?? targets.find(hasBudget) ?? targets[0] ?? null);
  return { targets, preferred };
}

/** A round number half again above both what was used and the current limit (min 1,000). */
export function suggestLimit(used: number, limit: number | null): number {
  const base = Math.max(used, limit ?? 0, 1);
  const raw = base * 1.5;
  const step = 10 ** Math.max(3, Math.floor(Math.log10(raw)) - 1);
  return Math.max(1000, Math.ceil(raw / step) * step);
}

/** Parses the operator's new token limit: a positive whole number above the current limit. */
export function parseLimit(
  text: string,
  current: number | null,
): { ok: true; value: number } | { ok: false; error: string } {
  const cleaned = text.replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return { ok: false, error: "Enter a whole number of tokens." };
  const value = Number(cleaned);
  if (value < 1) return { ok: false, error: "The limit must be at least 1 token." };
  if (current !== null && value <= current)
    return {
      ok: false,
      error: `Enter a limit above the current ${current.toLocaleString("en-US")} tokens.`,
    };
  return { ok: true, value };
}

/** Blocked by a budget: used up (`budget_exceeded`) or usage unknown (`budget_uncertain`). */
export const isBudgetBlocked = (t: Pick<Task, "status" | "blockedReason">) =>
  t.status === "blocked" &&
  (t.blockedReason === "budget_exceeded" || t.blockedReason === "budget_uncertain");

/** What a budget does on unknown usage when `onUnknown` is unset (core `enforce` defaults). */
export function effectiveOnUnknown(
  policy: Pick<BudgetPolicy, "enforce" | "onUnknown"> | null,
): BudgetOnUnknown {
  return policy?.onUnknown ?? (policy?.enforce === "soft" ? "allow" : "block");
}
