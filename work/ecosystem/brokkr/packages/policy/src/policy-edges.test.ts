import { describe, expect, it } from "vitest";
import type { ApprovedException } from "@brokkr/core";
import {
  SYSTEM_POLICY,
  UNANALYZABLE,
  analyzeCommand,
  evaluateAfter,
  evaluateBefore,
  harnessLayer,
  mergePolicies,
  type EffectivePolicy,
  type PlannedCheck,
} from "./index.js";

const NOW = new Date("2026-10-14T13:00:00Z");
const ctx = { taskId: "T-1", projectId: "p", harnesses: ["h@1.0.0"], now: NOW };

function check(id: string, command: string[]): PlannedCheck {
  return { id, command, cwd: ".", required: true, timeoutSeconds: 10, from: ["h@1.0.0"] };
}

function exception(over: Partial<ApprovedException>): ApprovedException {
  return {
    id: "x-1",
    policy: "install-dependencies",
    scope: { project: "p", task: "T-1" },
    reason: "r",
    approvedBy: "owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: [],
    ...over,
  };
}

describe("analyzeCommand: malformed wrapper and package-manager options fail closed", () => {
  const DENY: string[][] = [
    ["env", "--unset"], // long option missing its value
    ["env", "-Z", "ls"], // unknown short option
    ["env", "-u"], // short option missing its value
    ["npm", "--prefix"],
  ];
  for (const argv of DENY) {
    it(`denies ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBe(UNANALYZABLE);
    });
  }

  it("denies wrappers nested deeper than the analyser follows", () => {
    expect(analyzeCommand([...Array<string>(17).fill("nohup"), "ls"]).destructive).toBe(
      UNANALYZABLE,
    );
    expect(analyzeCommand([...Array<string>(16).fill("nohup"), "ls"]).destructive).toBeUndefined();
  });

  it("classifies find -exec without a terminator by the rest of the line", () => {
    expect(analyzeCommand(["find", ".", "-exec", "rm", "-rf", "{}"]).destructive).toBe("rm -rf");
    expect(analyzeCommand(["find", ".", "-exec", "ls", "{}"]).destructive).toBeUndefined();
  });

  it("git -c with no value, update-ref --delete, and interpreters with no script", () => {
    expect(analyzeCommand(["git", "-c"]).destructive).toBeUndefined();
    expect(analyzeCommand(["git", "update-ref", "--delete", "refs/heads/x"]).destructive).toBe(
      "git update-ref -d",
    );
    expect(analyzeCommand(["perl", "-w"]).destructive).toBeUndefined();
    expect(analyzeCommand(["tar"]).destructive).toBeUndefined();
  });

  it("sed options missing their value at the end of the line", () => {
    expect(analyzeCommand(["sed", "--expression"]).destructive).toBeUndefined();
    expect(analyzeCommand(["sed", "-n", "-e"]).destructive).toBeUndefined();
  });
});

describe("mergePolicies edges", () => {
  it("records the highest-precedence layer requiring a check, whatever the merge order", () => {
    const merged = mergePolicies([
      { layer: "organization", policy: { requiredCheckIds: ["t"] } },
      { layer: "project", policy: { requiredCheckIds: ["t"], waivable: ["check:t"] } },
    ]);
    expect(merged.conflicts).toEqual([
      "project policy may not make 'check:t' waivable: it is required by organization policy",
    ]);
  });

  it("lists a check allowed the network by two layers once", () => {
    const merged = mergePolicies([
      { layer: "organization", policy: { allowNetworkFor: ["audit"] } },
      { layer: "project", policy: { allowNetworkFor: ["audit"] } },
    ]);
    expect(merged.allowNetworkFor).toEqual([{ id: "audit", layer: "organization" }]);
  });

  it("harnessLayer omits waivable when no check is waivable", () => {
    expect(
      harnessLayer({ network: "deny", destructiveCommands: "allow", requireApprovalFor: [] }, [
        { id: "t" },
        { id: "u", waivable: false },
      ]),
    ).toEqual({ network: "deny", destructiveCommands: "allow", requireApprovalFor: [] });
  });
});

describe("evaluateBefore edges", () => {
  it("records an approval applied to the same check id once", () => {
    const policy = mergePolicies([{ layer: "system", policy: SYSTEM_POLICY }]);
    const install = check("deps", ["pnpm", "install"]);
    const result = evaluateBefore(
      { checks: [install, install], untrustedHarnesses: [] },
      policy,
      [exception({})],
      ctx,
    );
    expect(result.blocked).toEqual([]);
    expect(result.applied.map((e) => [e.id, e.appliedTo.checkId])).toEqual([["x-1", "deps"]]);
  });

  it("attributes denials to the system layer when a hand-built policy has no provenance", () => {
    const policy: EffectivePolicy = {
      ...mergePolicies([]),
      network: "deny",
      destructiveCommands: "deny",
      provenance: {},
    };
    const result = evaluateBefore(
      {
        checks: [check("rm", ["rm", "-rf", "x"]), check("audit", ["npm", "audit"])],
        untrustedHarnesses: [],
      },
      policy,
      [],
      ctx,
    );
    const before = result.decisions.filter((d) => d.outcome === "deny" && d.stage === "before");
    expect(before).toEqual([
      expect.objectContaining({ policy: "destructive-commands", layer: "system", checkId: "rm" }),
      expect.objectContaining({ policy: "network", layer: "system", checkId: "audit" }),
    ]);
  });
});

describe("evaluateAfter edges", () => {
  it("an expired waiver does not waive a missing required check", () => {
    const policy = mergePolicies([
      { layer: "project", policy: { requiredCheckIds: ["e2e"], waivable: ["check:e2e"] } },
    ]);
    const result = evaluateAfter([], policy, {
      exceptions: [exception({ policy: "check:e2e", expiresAt: "2026-10-14T12:30:00Z" })],
      ctx,
    });
    expect(result.unmet).toEqual(["required check 'e2e' is not defined by any selected harness"]);
    expect(result.applied).toEqual([]);
  });
});
