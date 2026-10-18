import { newId, type UsageSource } from "@mimir/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeBudget, makeUsage } from "./testing/fixtures.js";
import { budgetGuard, budgetScope, type BudgetPolicy } from "./budget.js";

const u = (tokens: number | null, estimatedCost: number | null, source: UsageSource = "measured") =>
  makeUsage({ tokens, estimatedCost, source });

describe("budgetGuard.remaining", () => {
  it.each([
    // name, limits, usage, expected subset
    [
      "no usage",
      { limitTokens: 100 },
      [],
      { tokens: 100, spentTokens: 0, uncertain: false, exhausted: false },
    ],
    [
      "measured + estimated both count",
      { limitTokens: 100 },
      [u(30, 0), u(20, 0, "estimated")],
      { tokens: 50, spentTokens: 50 },
    ],
    [
      "unavailable never counts but is uncertain",
      { limitTokens: 100 },
      [u(30, 0), u(500, 9, "unavailable")],
      { tokens: 70, spentTokens: 30, uncertain: true, exhausted: false },
    ],
    [
      "null tokens on a measured sample is uncertain",
      { limitTokens: 100 },
      [u(null, 0)],
      { tokens: 100, uncertain: true },
    ],
    [
      "null tokens irrelevant when tokens unlimited",
      { limitCost: 5 },
      [u(null, 1)],
      { tokens: null, cost: 4, uncertain: false },
    ],
    [
      "exhausted at exactly the limit",
      { limitTokens: 100 },
      [u(100, 0)],
      { tokens: 0, exhausted: true },
    ],
    [
      "overspent goes negative",
      { limitTokens: 100 },
      [u(150, 0)],
      { tokens: -50, exhausted: true },
    ],
    [
      "cost dimension exhausts independently",
      { limitTokens: 1000, limitCost: 1 },
      [u(10, 1.5)],
      { tokens: 990, cost: -0.5, exhausted: true },
    ],
    [
      "warn at fraction",
      { limitTokens: 100, warnAtFraction: 0.5 },
      [u(50, 0)],
      { warn: true, exhausted: false },
    ],
    ["below warn", { limitTokens: 100, warnAtFraction: 0.5 }, [u(49, 0)], { warn: false }],
    [
      "unlimited budget",
      {},
      [u(10, 1)],
      { tokens: null, cost: null, exhausted: false, warn: false },
    ],
  ] as const)("%s", (_n, limits, usage, want) => {
    const r = budgetGuard.remaining(makeBudget(limits), [...usage]);
    expect(r).toMatchObject(want);
  });
});

describe("budgetGuard.enforce", () => {
  const hard: Partial<BudgetPolicy> = { limitTokens: 100 };
  it.each([
    ["within, certain", hard, [u(10, 0)], "allow"],
    ["exhausted, hard (default)", hard, [u(100, 0)], "block"],
    ["exhausted, soft", { ...hard, enforce: "soft" }, [u(100, 0)], "allow"],
    ["uncertain, hard, default onUnknown -> block", hard, [u(1, 0, "unavailable")], "block"],
    [
      "uncertain, hard, onUnknown allow",
      { ...hard, onUnknown: "allow" },
      [u(1, 0, "unavailable")],
      "allow",
    ],
    [
      "uncertain, soft, default -> allow",
      { ...hard, enforce: "soft" },
      [u(1, 0, "unavailable")],
      "allow",
    ],
    [
      "uncertain, soft, onUnknown block",
      { ...hard, enforce: "soft", onUnknown: "block" },
      [u(1, 0, "unavailable")],
      "block",
    ],
    ["unlimited ignores uncertainty", {}, [u(1, 0, "unavailable")], "allow"],
    [
      "exhausted beats onUnknown allow",
      { ...hard, onUnknown: "allow" },
      [u(100, 0), u(1, 0, "unavailable")],
      "block",
    ],
  ] as const)("%s -> %s", (_n, policy, usage, want) => {
    const b = { ...makeBudget(), ...policy } as BudgetPolicy;
    expect(budgetGuard.enforce(b, budgetGuard.remaining(b, [...usage]))).toBe(want);
  });

  it("property: unavailable samples never change spend", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat(1000),
            fc.constantFrom<UsageSource>("measured", "estimated", "unavailable"),
          ),
        ),
        (samples) => {
          const b = makeBudget({ limitTokens: 5000 });
          const usage = samples.map(([t, s]) => u(t, 0, s));
          const r = budgetGuard.remaining(b, usage);
          const counted = samples
            .filter(([, s]) => s !== "unavailable")
            .reduce((a, [t]) => a + t, 0);
          expect(r.spentTokens).toBe(counted);
          expect(r.uncertain).toBe(samples.some(([, s]) => s === "unavailable"));
        },
      ),
    );
  });
});

describe("scope and attribution", () => {
  const msn = newId("msn");
  const crw = newId("crw");
  const other = newId("crw");
  const agA = newId("agt");
  const agB = newId("agt");
  const agX = newId("agt"); // unknown agent
  const agents = [
    { id: agA, crewId: crw },
    { id: agB, crewId: other },
  ];
  const crews = [
    { id: crw, missionId: msn },
    { id: other, missionId: newId("msn") },
  ];
  const usage = [
    makeUsage({ agentId: agA }),
    makeUsage({ agentId: agB }),
    makeUsage({ agentId: agX }),
  ];

  it.each([
    ["crew", { crewId: crw }, [0]],
    ["mission", { missionId: msn }, [0]],
    ["project", {}, [0, 1, 2]],
  ] as const)("%s budget sees its own usage", (scope, ids, want) => {
    const b = makeBudget(ids);
    expect(budgetScope(b)).toBe(scope);
    expect(budgetGuard.usageInScope(b, usage, { agents, crews })).toEqual(
      want.map((i) => usage[i]),
    );
  });

  it.each([
    ["crew", { crewId: crw }, { crewId: crw, missionId: msn }, true],
    ["crew other", { crewId: other }, { crewId: crw, missionId: msn }, false],
    ["mission", { missionId: msn }, { crewId: crw, missionId: msn }, true],
    ["mission other", { missionId: newId("msn") }, { crewId: crw, missionId: msn }, false],
    ["project", {}, { crewId: crw, missionId: msn }, true],
  ] as const)("appliesTo %s -> %s", (_n, ids, target, want) => {
    expect(budgetGuard.appliesTo(makeBudget(ids), target)).toBe(want);
  });

  it.each([
    ["crew", { crewId: crw }, true],
    ["mission", { missionId: msn }, true],
    ["project", {}, false],
  ] as const)(
    "evaluate: unattributable usage makes a %s budget uncertain=%s (fails closed)",
    (_n, ids, uncertain) => {
      const b = makeBudget({ ...ids, limitTokens: 1000 });
      const r = budgetGuard.evaluate(b, usage, { agents, crews });
      expect(r.uncertain).toBe(uncertain);
      expect(budgetGuard.enforce(b, r)).toBe(uncertain ? "block" : "allow");
    },
  );

  it("evaluate: fully attributed usage is certain", () => {
    const b = makeBudget({ crewId: crw, limitTokens: 1000 });
    const r = budgetGuard.evaluate(b, usage.slice(0, 2), { agents, crews });
    expect(r.uncertain).toBe(false);
  });

  it("evaluate: omitted attribution makes every crew-scoped sample unattributable", () => {
    const b = makeBudget({ crewId: crw, limitTokens: 1000 });
    expect(budgetGuard.evaluate(b, usage, { agents: [], crews }).uncertain).toBe(true);
    expect(budgetGuard.evaluate(b, [], { agents: [], crews }).uncertain).toBe(false);
  });
});
