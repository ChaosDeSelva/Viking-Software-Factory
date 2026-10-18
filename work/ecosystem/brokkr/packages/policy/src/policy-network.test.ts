import { describe, expect, it } from "vitest";
import type { ApprovedException } from "@brokkr/core";
import {
  SYSTEM_POLICY,
  analyzeCommand,
  createLineRedactor,
  evaluateBefore,
  mergePolicies,
  type PlannedCheck,
} from "./index.js";

const NOW = new Date("2026-10-14T13:00:00Z");
const ctx = { harnesses: ["h@1.0.0"], now: NOW };

function check(id: string, command: string[]): PlannedCheck {
  return { id, command, cwd: ".", required: true, timeoutSeconds: 10, from: ["h@1.0.0"] };
}

function approval(over: Partial<ApprovedException> = {}): ApprovedException {
  return {
    id: "net-1",
    policy: "network-access",
    scope: {},
    reason: "dependency audit needs the registry",
    approvedBy: "owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: [],
    ...over,
  };
}

describe("network-dependent commands", () => {
  it("detects package-manager audits as needing the network", () => {
    for (const argv of [
      ["pnpm", "audit", "--json"],
      ["npm", "audit"],
      ["yarn", "npm", "audit"],
      ["pnpm", "install"],
    ])
      expect(analyzeCommand(argv).needsNetwork, argv.join(" ")).toBe(true);
    for (const argv of [
      ["pnpm", "test"],
      ["node", "audit.js"],
      ["yarn", "npm", "publish"],
    ])
      expect(analyzeCommand(argv).needsNetwork, argv.join(" ")).toBe(false);
  });

  const harnessDeny = mergePolicies([
    { layer: "system", policy: SYSTEM_POLICY },
    { layer: "harness", policy: { network: "deny" } },
  ]);

  it("network deny + audit without approval: networkDenied, not blocked", () => {
    const r = evaluateBefore(
      { checks: [check("audit", ["pnpm", "audit"])], untrustedHarnesses: [] },
      harnessDeny,
      [],
      ctx,
    );
    expect(r.blocked).toEqual([]);
    expect(r.networkDenied.get("audit")).toMatch(
      /needs network access.*harness policy.*network-access/,
    );
    expect(r.decisions).toContainEqual(
      expect.objectContaining({
        policy: "network",
        outcome: "deny",
        layer: "harness",
        checkId: "audit",
      }),
    );
  });

  it("check-bound approval exceptions grant network per check and are recorded per check", () => {
    const r = evaluateBefore(
      {
        checks: [check("audit-a", ["pnpm", "audit"]), check("audit-b", ["npm", "audit"])],
        untrustedHarnesses: [],
      },
      harnessDeny,
      [
        approval({ policy: "network-access:audit-a" }),
        approval({ id: "net-2", scope: { checkId: "audit-b" } }),
      ],
      ctx,
    );
    expect([...r.networkApproved].sort()).toEqual(["audit-a", "audit-b"]);
    expect(r.applied.map((e) => e.appliedTo.checkId)).toEqual(["audit-a", "audit-b"]);
    expect(r.decisions.filter((d) => d.outcome === "approved")).toHaveLength(2);
  });

  it("network allow needs no approval and records an allow decision", () => {
    const allow = mergePolicies([{ layer: "system", policy: SYSTEM_POLICY }]);
    const r = evaluateBefore(
      { checks: [check("audit", ["pnpm", "audit"])], untrustedHarnesses: [] },
      allow,
      [],
      ctx,
    );
    expect(r.networkDenied.size).toBe(0);
    expect(r.decisions).toContainEqual(
      expect.objectContaining({
        policy: "network",
        stage: "runtime",
        outcome: "allow",
        message: "network allowed",
      }),
    );
  });

  it("ignores approvals dated in the future", () => {
    const r = evaluateBefore(
      { checks: [check("audit", ["pnpm", "audit"])], untrustedHarnesses: [] },
      harnessDeny,
      [approval({ approvedAt: "2026-10-14T14:00:00Z" })],
      ctx,
    );
    expect(r.networkApproved.size).toBe(0);
    expect(r.warnings.join()).toMatch(/approved in the future/);
  });

  it("a destructive denial is attributed to the layer that set it", () => {
    const harnessOnly = mergePolicies([
      { layer: "harness", policy: { destructiveCommands: "deny" } },
    ]);
    const r = evaluateBefore(
      { checks: [check("x", ["rm", "-rf", "x"])], untrustedHarnesses: [] },
      harnessOnly,
      [],
      ctx,
    );
    expect(r.decisions).toContainEqual(
      expect.objectContaining({ policy: "destructive-commands", layer: "harness" }),
    );
  });

  it("an empty argv is checked against the allowlist as an empty executable", () => {
    const p = mergePolicies([{ layer: "project", policy: { allowedCommands: ["pnpm"] } }]);
    const r = evaluateBefore({ checks: [check("x", [])], untrustedHarnesses: [] }, p, [], ctx);
    expect(r.denied.get("x")).toMatch(/executable '' is not in the project allowedCommands/);
  });
});

describe("merge details", () => {
  it("repeated deny and duplicate waivable entries are idempotent", () => {
    const p = mergePolicies([
      { layer: "organization", policy: { network: "deny", waivable: ["check:a"] } },
      { layer: "project", policy: { network: "deny", waivable: ["check:a"] } },
    ]);
    expect(p.network).toBe("deny");
    expect(p.provenance.network).toBe("organization");
    expect(p.waivable).toEqual(["check:a"]);
    expect(p.warnings).toEqual([]);
  });
});

describe("command analysis wrappers", () => {
  it("unwraps timeout and git global options", () => {
    expect(analyzeCommand(["timeout", "-s", "KILL", "30", "rm", "-rf", "x"]).destructive).toBe(
      "rm -rf",
    );
    expect(
      analyzeCommand(["git", "-c", "color.ui=false", "--no-pager", "push", "--force"]).destructive,
    ).toBe("git push --force");
    expect(analyzeCommand(["git", "clean", "--force"]).destructive).toBe("git clean -f");
    expect(analyzeCommand(["git"]).destructive).toBeUndefined();
  });
});

describe("line redactor flush", () => {
  it("flushes nothing when the buffer is empty", () => {
    const r = createLineRedactor();
    expect(r.write("done\n")).toBe("done\n");
    expect(r.flush()).toBe("");
  });
});

describe("env split-string", () => {
  it("treats env -S like a shell string that cannot be inspected", () => {
    expect(analyzeCommand(["env", "-S", "rm -rf /"]).destructive).toBe("env -S");
    expect(analyzeCommand(["env", "--split-string=rm -rf /"]).destructive).toBe("env -S");
    expect(analyzeCommand(["env", "-i", "FOO=1", "node", "x.js"]).destructive).toBeUndefined();
  });
});

describe("network deny makes package managers fail fast", () => {
  it("sets offline mode for npm, pnpm and yarn", async () => {
    const { applyNetworkPolicy } = await import("./index.js");
    const env = applyNetworkPolicy("deny", { PATH: "/bin" });
    expect(env).toMatchObject({
      npm_config_offline: "true",
      pnpm_config_offline: "true",
      YARN_ENABLE_OFFLINE_MODE: "1",
    });
    expect(applyNetworkPolicy("allow", { PATH: "/bin" }).pnpm_config_offline).toBeUndefined();
  });
});
