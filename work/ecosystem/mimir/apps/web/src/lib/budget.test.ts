import type { BudgetPolicy } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { crew, event, task } from "../test/fixtures.js";
import {
  budgetTargets,
  currentPolicy,
  isBudgetBlocked,
  latestExceeded,
  parseLimit,
  suggestLimit,
} from "./budget.js";

const policy = (over: Partial<BudgetPolicy>): BudgetPolicy => ({
  id: "bgt_1" as BudgetPolicy["id"],
  missionId: null,
  crewId: null,
  limitTokens: 1000,
  limitCost: null,
  warnAtFraction: 0.8,
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  version: 0,
  ...over,
});

describe("budget logic", () => {
  const c = crew();
  const other = crew({ missionId: c.missionId });

  it("rebuilds a crew's policy from creation, then the newest update for that crew", () => {
    const events = [
      event("crew.created", {
        crew: c,
        members: [],
        budget: policy({ crewId: c.id, limitTokens: 100 }),
      }),
      event("budget.updated", {
        budget: policy({ crewId: other.id, limitTokens: 999, version: 4 }),
        previous: null,
      }),
      event("budget.updated", {
        budget: policy({ crewId: c.id, limitTokens: 200, version: 1 }),
        previous: null,
      }),
    ];
    expect(currentPolicy(events, { kind: "crew", crewId: c.id })).toMatchObject({
      limitTokens: 200,
      version: 1,
    });
    expect(currentPolicy(events, { kind: "mission" })).toBeNull();
  });

  it("reads the newest exceeded event and its scope", () => {
    const events = [
      event(
        "budget.exceeded",
        { budgetId: "bgt_a" as never, unit: "tokens", used: 50, limit: 40 },
        { crewId: c.id },
      ),
      event("budget.exceeded", {
        budgetId: "bgt_b" as never,
        unit: "tokens",
        used: 90,
        limit: 80,
        scope: "mission",
      }),
    ];
    expect(latestExceeded(events)).toMatchObject({ crewId: null, scope: "mission", used: 90 });
    expect(latestExceeded([])).toBeNull();
  });

  it("prefers the crew the exceeded event names, else the task's crew", () => {
    const exceeded = {
      budgetId: "b",
      crewId: other.id as string,
      scope: "crew" as const,
      unit: "tokens" as const,
      used: 1,
      limit: 1,
      at: "",
    };
    expect(budgetTargets(task({ crewId: null }), [c, other], exceeded).preferred).toEqual({
      kind: "crew",
      crewId: other.id,
    });
    const own = budgetTargets(task({ crewId: c.id }), [c, other], null);
    expect(own.targets).toEqual([{ kind: "crew", crewId: c.id }]);
    const mission = budgetTargets(undefined, [c], { ...exceeded, crewId: null, scope: "mission" });
    expect(mission.preferred).toEqual({ kind: "mission" });
    // No exceeded event (unknown usage): the budget that exists is preselected.
    const onlyMission = budgetTargets(undefined, [c], null, (t) => t.kind === "mission");
    expect(onlyMission.targets).toEqual([{ kind: "crew", crewId: c.id }, { kind: "mission" }]);
    expect(onlyMission.preferred).toEqual({ kind: "mission" });
  });

  it("suggests a round limit above both use and limit, and validates input", () => {
    expect(suggestLimit(120_000, 100_000)).toBe(180_000);
    expect(suggestLimit(900, null)).toBe(2000);
    expect(suggestLimit(0, null)).toBe(1000);
    expect(parseLimit("150,000", 100_000)).toEqual({ ok: true, value: 150_000 });
    expect(parseLimit("abc", null).ok).toBe(false);
    expect(parseLimit("0", null).ok).toBe(false);
    expect(parseLimit("100000", 100_000)).toMatchObject({ ok: false, error: /above the current/ });
  });

  it("only a budget_exceeded block can be raised", () => {
    expect(isBudgetBlocked(task({ status: "blocked", blockedReason: "budget_exceeded" }))).toBe(
      true,
    );
    expect(isBudgetBlocked(task({ status: "blocked", blockedReason: "approval" }))).toBe(false);
    expect(isBudgetBlocked(task({ status: "blocked", blockedReason: "budget_uncertain" }))).toBe(
      true,
    );
    expect(isBudgetBlocked(task({ status: "ready" }))).toBe(false);
  });
});
