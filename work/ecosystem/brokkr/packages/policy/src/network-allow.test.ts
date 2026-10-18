import { describe, expect, it } from "vitest";
import { validateWith, PolicyLayerSchema, type ApprovedException } from "@brokkr/core";
import { SYSTEM_POLICY, evaluateBefore, mergePolicies, type PlannedCheck } from "./index.js";

const NOW = new Date("2026-10-14T13:00:00Z");
const ctx = { harnesses: ["h@1.0.0"], now: NOW };

function check(id: string, command: string[]): PlannedCheck {
  return { id, command, cwd: ".", required: true, timeoutSeconds: 10, from: ["h@1.0.0"] };
}
const plan = {
  checks: [check("audit", ["pnpm", "audit"]), check("outdated", ["pnpm", "outdated"])],
  untrustedHarnesses: [],
};

function approval(over: Partial<ApprovedException>): ApprovedException {
  return {
    id: "net-1",
    policy: "network-access",
    scope: {},
    reason: "audit needs the registry",
    approvedBy: "owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: [],
    ...over,
  };
}

describe("allowNetworkFor (ruling b)", () => {
  it("is part of the policy layer schema", () => {
    expect(validateWith(PolicyLayerSchema, { allowNetworkFor: ["audit"] }).ok).toBe(true);
  });

  it("project allowNetworkFor opens the network for exactly the listed check", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "project", policy: { allowNetworkFor: ["audit"] } },
      { layer: "harness", policy: { network: "deny" } },
    ]);
    const r = evaluateBefore(plan, p, [], ctx);
    expect([...r.networkApproved]).toEqual(["audit"]);
    expect([...r.networkDenied.keys()]).toEqual(["outdated"]);
    expect(r.decisions).toContainEqual(
      expect.objectContaining({
        policy: "network-access",
        outcome: "approved",
        layer: "project",
        checkId: "audit",
        message: expect.stringMatching(/allowNetworkFor/),
      }),
    );
  });

  it("harness and task layers cannot set it", () => {
    for (const layer of ["harness", "task"] as const) {
      const p = mergePolicies([
        { layer: "harness", policy: { network: "deny" } },
        { layer, policy: { allowNetworkFor: ["audit"] } },
      ]);
      expect(p.allowNetworkFor, layer).toEqual([]);
      expect(p.warnings.join(), layer).toMatch(
        new RegExp(`${layer} policy may not set allowNetworkFor`),
      );
    }
  });

  it("is ignored when the organization denies network itself or makes network-access non-waivable", () => {
    const orgDeny = mergePolicies([
      { layer: "organization", policy: { network: "deny" } },
      { layer: "project", policy: { allowNetworkFor: ["audit"] } },
    ]);
    expect(orgDeny.allowNetworkFor).toEqual([]);
    expect(orgDeny.warnings.join()).toMatch(/organization denies network/);
    const orgLock = mergePolicies([
      { layer: "organization", policy: { nonWaivable: ["network-access"] } },
      { layer: "project", policy: { allowNetworkFor: ["audit"] } },
    ]);
    expect(orgLock.allowNetworkFor).toEqual([]);
  });

  it("warns about ids that match no check", () => {
    const p = mergePolicies([
      { layer: "harness", policy: { network: "deny" } },
      { layer: "project", policy: { allowNetworkFor: ["nope"] } },
    ]);
    expect(evaluateBefore(plan, p, [], ctx).warnings.join()).toMatch(
      /allowNetworkFor.*'nope'.*no such check/,
    );
  });
});

describe("network-access approvals are bound to a check id", () => {
  const deny = mergePolicies([{ layer: "harness", policy: { network: "deny" } }]);

  it("an unbound network-access exception approves nothing and warns", () => {
    const r = evaluateBefore(plan, deny, [approval({})], ctx);
    expect(r.networkApproved.size).toBe(0);
    expect(r.warnings.join()).toMatch(/net-1.*must name a check/);
  });

  it("policy network-access:<checkId> approves only that check", () => {
    const r = evaluateBefore(plan, deny, [approval({ policy: "network-access:audit" })], ctx);
    expect([...r.networkApproved]).toEqual(["audit"]);
    expect(r.applied.map((e) => e.appliedTo.checkId)).toEqual(["audit"]);
  });

  it("scope.checkId approves only that check", () => {
    const r = evaluateBefore(plan, deny, [approval({ scope: { checkId: "outdated" } })], ctx);
    expect([...r.networkApproved]).toEqual(["outdated"]);
  });
});

describe("org requireApprovalFor network-access is enforced (fix round 2, minor 5)", () => {
  it("allowNetworkFor does not bypass an org approval requirement", () => {
    const p = mergePolicies([
      { layer: "organization", policy: { requireApprovalFor: ["network-access"] } },
      { layer: "harness", policy: { network: "deny" } },
      { layer: "project", policy: { allowNetworkFor: ["audit"] } },
    ]);
    expect(p.allowNetworkFor).toEqual([]);
    expect(p.warnings.join()).toMatch(/organization requires approval for network-access/);
  });
});
