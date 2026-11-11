import { newId, type CrewId } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { applyDecisions } from "./apply.js";
import { budgetGuard } from "./budget.js";
import { makeBudget, makeCrew, makeMission, makeTask, makeUsage } from "./testing/fixtures.js";
import { toIso, toMs } from "./time.js";

describe("toMs", () => {
  it("accepts epoch ms, ISO strings and dates", () => {
    expect(toMs(1234)).toBe(1234);
    expect(toMs("1970-01-01T00:00:01.000Z")).toBe(1000);
    expect(toMs(new Date(5))).toBe(5);
    expect(toIso(1000)).toBe("1970-01-01T00:00:01.000Z");
  });
});

describe("budgetGuard.remaining", () => {
  it("a counted sample without a cost is uncertain only when cost is limited", () => {
    const sample = makeUsage({ tokens: 1, estimatedCost: null });
    expect(budgetGuard.remaining(makeBudget({ limitCost: 5 }), [sample])).toMatchObject({
      cost: 5,
      uncertain: true,
    });
    expect(budgetGuard.remaining(makeBudget({ limitTokens: 5 }), [sample])).toMatchObject({
      tokens: 4,
      uncertain: false,
    });
  });
});

describe("applyDecisions", () => {
  const base = () => {
    const mission = makeMission();
    const crew = makeCrew(mission);
    const task = makeTask({ missionId: mission.id, status: "ready" });
    return {
      now: new Date(0),
      missions: [mission],
      crews: [crew],
      tasks: [task],
      deps: [],
      leases: [],
      usage: [],
      budgets: [],
      agents: [],
    };
  };
  it("rejects a decision naming a crew, task or mission that is not in the input", () => {
    const input = base();
    const taskId = input.tasks[0]!.id;
    expect(() =>
      applyDecisions(input, [{ kind: "dispatch", taskId, crewId: newId("crw") as CrewId }]),
    ).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() =>
      applyDecisions({ ...input, tasks: [] }, [
        { kind: "dispatch", taskId, crewId: input.crews[0]!.id },
      ]),
    ).toThrow(expect.objectContaining({ code: "not_found", details: { taskId } }));
  });
});
