import { describe, expect, it } from "vitest";
import type { ApprovedException } from "@brokkr/core";
import { SYSTEM_POLICY, evaluateBefore, mergePolicies } from "./index.js";

const NOW = new Date("2026-10-14T13:00:00Z");

const exc: ApprovedException = {
  id: "exc-1",
  policy: "check:typecheck",
  scope: {},
  reason: "r",
  approvedBy: "agent",
  approvedAt: "2026-10-14T12:00:00Z",
  expiresAt: "2026-10-15T12:00:00Z",
  evidence: [],
};

describe("task layer cannot weaken (B2 review I2)", () => {
  it("ignores waivable from the task layer with a warning", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "task", policy: { waivable: ["check:typecheck"] } },
    ]);
    expect(p.waivable).toEqual([]);
    expect(p.warnings.join("\n")).toMatch(
      /task policy may not mark 'check:typecheck' waivable; ignored/,
    );
  });

  it("so a task-supplied exception cannot skip a required check", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "task", policy: { waivable: ["check:typecheck"] } },
    ]);
    const r = evaluateBefore(
      {
        checks: [
          {
            id: "typecheck",
            command: ["pnpm", "exec", "tsc"],
            cwd: ".",
            required: true,
            timeoutSeconds: 1,
            from: [],
          },
        ],
        untrustedHarnesses: [],
      },
      p,
      [exc],
      { harnesses: [], now: NOW },
    );
    expect(r.waived.size).toBe(0);
  });

  it("organization, project and harness layers may still declare waivable ids", () => {
    for (const layer of ["organization", "project", "harness"] as const) {
      const p = mergePolicies([{ layer, policy: { waivable: ["check:visual"] } }]);
      expect(p.waivable, layer).toEqual(["check:visual"]);
    }
  });
});

describe("waivers follow requirement precedence (fix round 2, I2)", () => {
  const plan = {
    checks: [
      {
        id: "unit",
        command: ["pnpm", "test"],
        cwd: ".",
        required: true,
        timeoutSeconds: 1,
        from: [],
      },
    ],
    untrustedHarnesses: [],
  };
  const exc = {
    ...{
      id: "e1",
      policy: "check:unit",
      scope: {},
      reason: "r",
      approvedBy: "lead",
      approvedAt: "2026-10-14T12:00:00Z",
      expiresAt: "2026-10-15T12:00:00Z",
      evidence: [],
    },
  };

  it("P1: a project cannot waive a check the organization requires: the run is blocked with a reason", () => {
    const p = mergePolicies([
      { layer: "organization", policy: { requiredCheckIds: ["unit"] } },
      { layer: "project", policy: { waivable: ["check:unit"] } },
    ]);
    expect(p.waivable).toEqual([]);
    expect(p.conflicts).toEqual([
      "project policy may not make 'check:unit' waivable: it is required by organization policy",
    ]);
    const r = evaluateBefore(plan, p, [exc], { harnesses: [], now: NOW });
    expect(r.waived.size).toBe(0);
    expect(r.blocked).toContain(
      "policy_conflict: project policy may not make 'check:unit' waivable: it is required by organization policy",
    );
    expect(r.decisions).toContainEqual(
      expect.objectContaining({ policy: "policy-conflict", outcome: "deny", layer: "project" }),
    );
  });

  it("P2: neither can the harness layer", () => {
    const p = mergePolicies([
      { layer: "organization", policy: { requiredCheckIds: ["unit"] } },
      { layer: "harness", policy: { waivable: ["check:unit"] } },
    ]);
    expect(p.conflicts.join()).toMatch(/harness policy may not make 'check:unit' waivable/);
  });

  it("a layer may waive checks required at its own or a lower layer", () => {
    expect(
      mergePolicies([
        { layer: "project", policy: { requiredCheckIds: ["unit"], waivable: ["check:unit"] } },
      ]),
    ).toMatchObject({ waivable: ["check:unit"], conflicts: [] });
    expect(
      mergePolicies([
        { layer: "organization", policy: { waivable: ["check:unit"] } },
        { layer: "project", policy: { requiredCheckIds: ["unit"] } },
      ]),
    ).toMatchObject({ waivable: ["check:unit"], conflicts: [] });
    // harness-required (not in any requiredCheckIds) is waivable from the project
    expect(
      mergePolicies([{ layer: "project", policy: { waivable: ["check:unit"] } }]).waivable,
    ).toEqual(["check:unit"]);
  });
});

it("requirement precedence does not depend on caller layer order", () => {
  const p = mergePolicies([
    { layer: "project", policy: { requiredCheckIds: ["unit"], waivable: ["check:unit"] } },
    { layer: "organization", policy: { requiredCheckIds: ["unit"] } },
  ]);
  expect(p.waivable).toEqual([]);
  expect(p.conflicts.join()).toMatch(/required by organization/);
});
