import type {
  AgentId,
  Budget,
  BudgetId,
  Crew,
  CrewId,
  MissionId,
  UsageSample,
} from "@mimir/protocol";

/** `hard` budgets block dispatch when exhausted; `soft` budgets only warn. */
export type BudgetEnforce = "hard" | "soft";
/** What to do when spend is uncertain (an `unavailable` sample, or a missing value in a limited dimension). */
export type BudgetOnUnknown = "allow" | "block";

/**
 * A protocol Budget plus enforcement settings. Both are optional:
 * `enforce` defaults to `hard`; `onUnknown` defaults to `block` for hard budgets and `allow` for soft ones.
 */
export type BudgetPolicy = Budget & { enforce?: BudgetEnforce; onUnknown?: BudgetOnUnknown };

/** crew if crewId is set, else mission if missionId is set, else project-wide. */
export type BudgetScope = "crew" | "mission" | "project";

export function budgetScope(budget: Pick<Budget, "crewId" | "missionId">): BudgetScope {
  if (budget.crewId !== null) return "crew";
  if (budget.missionId !== null) return "mission";
  return "project";
}

export interface BudgetRemaining {
  budgetId: BudgetId;
  scope: BudgetScope;
  /** Remaining tokens (may be negative); null when the budget has no token limit. */
  tokens: number | null;
  /** Remaining cost (may be negative); null when the budget has no cost limit. */
  cost: number | null;
  spentTokens: number;
  spentCost: number;
  /** Some spend could not be counted, so the real remaining may be lower. */
  uncertain: boolean;
  /** Some limited dimension has remaining <= 0. */
  exhausted: boolean;
  /** Spend reached `warnAtFraction` of some limit. */
  warn: boolean;
}

/**
 * Remaining budget given the usage samples already in this budget's scope.
 * `unavailable` samples never count as spend but make the result `uncertain`.
 * So does a null value on a counted (measured/estimated) sample in a dimension
 * the budget limits: spend we cannot see is treated like unavailable spend.
 * Note: with the hard-budget default `onUnknown: 'block'`, a single such sample
 * blocks dispatch under that budget until `onUnknown: 'allow'` is set, so the
 * UI should show `uncertain` as the reason.
 */
function remaining(scope: Budget, usage: readonly UsageSample[]): BudgetRemaining {
  let spentTokens = 0;
  let spentCost = 0;
  let uncertain = false;
  for (const s of usage) {
    if (s.source === "unavailable") {
      uncertain = true;
      continue;
    }
    if (s.tokens === null) {
      if (scope.limitTokens !== null) uncertain = true;
    } else spentTokens += s.tokens;
    if (s.estimatedCost === null) {
      if (scope.limitCost !== null) uncertain = true;
    } else spentCost += s.estimatedCost;
  }
  const tokens = scope.limitTokens === null ? null : scope.limitTokens - spentTokens;
  const cost = scope.limitCost === null ? null : scope.limitCost - spentCost;
  const exhausted = (tokens !== null && tokens <= 0) || (cost !== null && cost <= 0);
  const warn =
    (scope.limitTokens !== null && spentTokens >= scope.warnAtFraction * scope.limitTokens) ||
    (scope.limitCost !== null && spentCost >= scope.warnAtFraction * scope.limitCost);
  return {
    budgetId: scope.id,
    scope: budgetScope(scope),
    tokens,
    cost,
    spentTokens,
    spentCost,
    uncertain,
    exhausted,
    warn,
  };
}

/** Whether a budget lets new work start, given its computed remaining. */
function enforce(budget: BudgetPolicy, r: BudgetRemaining): "allow" | "block" {
  if (budget.limitTokens === null && budget.limitCost === null) return "allow";
  const mode = budget.enforce ?? "hard";
  if (r.exhausted) return mode === "hard" ? "block" : "allow";
  if (r.uncertain) return budget.onUnknown ?? (mode === "hard" ? "block" : "allow");
  return "allow";
}

export interface UsageAttribution {
  agents: readonly { id: AgentId; crewId: CrewId }[];
  crews: readonly Pick<Crew, "id" | "missionId">[];
}

/**
 * Samples that count against a budget. Samples are attributed agent -> crew -> mission;
 * samples from unknown agents count only against project-wide budgets.
 */
function usageInScope(
  budget: Pick<Budget, "crewId" | "missionId">,
  usage: readonly UsageSample[],
  attribution: UsageAttribution,
): UsageSample[] {
  const scope = budgetScope(budget);
  if (scope === "project") return [...usage];
  const agentCrew = new Map<string, CrewId>(attribution.agents.map((a) => [a.id, a.crewId]));
  const crewMission = new Map<string, MissionId>(attribution.crews.map((c) => [c.id, c.missionId]));
  return usage.filter((s) => {
    const crewId = agentCrew.get(s.agentId);
    if (crewId === undefined) return false;
    if (scope === "crew") return crewId === budget.crewId;
    return crewMission.get(crewId) === budget.missionId;
  });
}

/** Whether a budget governs work done by `target` (a crew in a mission). */
function appliesTo(
  budget: Pick<Budget, "crewId" | "missionId">,
  target: { crewId: CrewId; missionId: MissionId },
): boolean {
  switch (budgetScope(budget)) {
    case "crew":
      return budget.crewId === target.crewId;
    case "mission":
      return budget.missionId === target.missionId;
    case "project":
      return true;
  }
}

/**
 * `remaining` over the samples in the budget's scope. For crew and mission
 * budgets, a sample whose agent cannot be attributed to a crew (or whose crew
 * cannot be attributed to a mission) might belong to this scope, so it makes
 * the result `uncertain`; hard budgets then block by default (fail closed).
 */
function evaluate(
  budget: Budget,
  usage: readonly UsageSample[],
  attribution: UsageAttribution,
): BudgetRemaining {
  const r = remaining(budget, usageInScope(budget, usage, attribution));
  if (budgetScope(budget) === "project" || r.uncertain) return r;
  const agentCrew = new Map<string, CrewId>(attribution.agents.map((a) => [a.id, a.crewId]));
  const knownCrews = new Set<string>(attribution.crews.map((c) => c.id));
  const unattributed = usage.some((s) => {
    const crewId = agentCrew.get(s.agentId);
    return crewId === undefined || !knownCrews.has(crewId);
  });
  return unattributed ? { ...r, uncertain: true } : r;
}

export const budgetGuard = { remaining, evaluate, enforce, usageInScope, appliesTo } as const;
