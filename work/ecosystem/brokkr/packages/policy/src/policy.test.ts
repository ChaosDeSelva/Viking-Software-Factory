import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovedException } from "@brokkr/core";
import {
  NETWORK_DENY_PROXY,
  SYSTEM_POLICY,
  analyzeCommand,
  applyNetworkPolicy,
  evaluateAfter,
  evaluateBefore,
  globToRegExp,
  harnessLayer,
  loadExceptions,
  loadOrgPolicy,
  mergePolicies,
  type PlannedCheck,
  type VerificationPlan,
} from "./index.js";

function check(id: string, command: string[], extra: Partial<PlannedCheck> = {}): PlannedCheck {
  return { id, command, cwd: ".", required: true, timeoutSeconds: 10, from: ["h@1.0.0"], ...extra };
}

function plan(checks: PlannedCheck[], extra: Partial<VerificationPlan> = {}): VerificationPlan {
  return { checks, untrustedHarnesses: [], ...extra };
}

const NOW = new Date("2026-10-14T13:00:00Z");
const ctx = { taskId: "UI-142", projectId: "ravensight", harnesses: ["h@1.0.0"], now: NOW };

function exception(over: Partial<ApprovedException> = {}): ApprovedException {
  return {
    id: "exception-001",
    policy: "check:visual",
    scope: { project: "ravensight", task: "UI-142" },
    reason: "baseline unavailable",
    approvedBy: "project-owner",
    approvedAt: "2026-10-14T12:00:00Z",
    expiresAt: "2026-10-15T12:00:00Z",
    evidence: ["manual-review-142"],
    ...over,
  };
}

describe("analyzeCommand: destructive operations", () => {
  const destructive: Array<[string[], string]> = [
    [["rm", "-rf", "/"], "rm -rf"],
    [["rm", "-fr", "dist"], "rm -rf"],
    [["rm", "-r", "-f", "x"], "rm -rf"],
    [["/bin/rm", "--recursive", "--force", "x"], "rm -rf"],
    [["git", "push", "--force"], "git push --force"],
    [["git", "push", "-f", "origin", "main"], "git push --force"],
    [["git", "push", "--force-with-lease"], "git push --force"],
    [["git", "push", "origin", "+main"], "git push --force"],
    [["git", "-C", "repo", "reset", "--hard", "HEAD~1"], "git reset --hard"],
    [["git", "clean", "-fdx"], "git clean -f"],
    [["dd", "if=/dev/zero", "of=/dev/disk0"], "dd"],
    [["mkfs.ext4", "/dev/sda1"], "mkfs"],
    [["mkfs", "-t", "ext4"], "mkfs"],
    [["sudo", "ls"], "sudo"],
    [["env", "FOO=1", "rm", "-rf", "x"], "rm -rf"],
    [["pnpm", "exec", "rm", "-rf", "x"], "rm -rf"],
    [["npx", "rimraf", "x"], "rimraf"],
    [["xargs", "-0", "rm", "-rf"], "rm -rf"],
    [["nice", "-n", "5", "git", "reset", "--hard"], "git reset --hard"],
    [["sh", "-c", "echo hi"], "shell -c"],
    [["bash", "-lc", "echo hi"], "shell -c"],
  ];
  for (const [argv, label] of destructive) {
    it(`denies ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBe(label);
    });
  }

  const safe: string[][] = [
    ["rm", "file.txt"],
    ["git", "push"],
    ["git", "reset", "--soft", "HEAD"],
    ["git", "status"],
    ["pnpm", "test", "--run"],
    ["node", "--test"],
    ["sh", "script.sh"],
    ["env"],
  ];
  for (const argv of safe) {
    it(`allows ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).destructive).toBeUndefined();
    });
  }
});

describe("analyzeCommand: dependency installation", () => {
  const installs = [
    ["npm", "install"],
    ["npm", "i", "left-pad"],
    ["npm", "ci"],
    ["pnpm", "install"],
    ["pnpm", "add", "zod"],
    ["yarn"],
    ["yarn", "add", "zod"],
    ["bun", "install"],
    ["env", "CI=1", "pnpm", "i"],
  ];
  for (const argv of installs) {
    it(`flags ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).dependencyInstall).toBe(true);
    });
  }
  for (const argv of [
    ["pnpm", "test"],
    ["npm", "run", "install-hooks"],
    ["yarn", "test"],
  ]) {
    it(`does not flag ${argv.join(" ")}`, () => {
      expect(analyzeCommand(argv).dependencyInstall).toBe(false);
    });
  }
});

describe("globToRegExp", () => {
  it("matches argv[0] globs", () => {
    expect(globToRegExp("pnpm").test("pnpm")).toBe(true);
    expect(globToRegExp("pnpm").test("pnpmx")).toBe(false);
    expect(globToRegExp("./scripts/*").test("./scripts/check.sh")).toBe(true);
    expect(globToRegExp("./scripts/*").test("./scripts/a/b.sh")).toBe(false);
    expect(globToRegExp("./scripts/**").test("./scripts/a/b.sh")).toBe(true);
    expect(globToRegExp("node?").test("node2")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("mergePolicies: precedence and strengthen-only", () => {
  it("system layer denies destructive commands and protects security policies", () => {
    const p = mergePolicies([{ layer: "system", policy: SYSTEM_POLICY }]);
    expect(p.destructiveCommands).toBe("deny");
    expect(p.requireApprovalFor).toContain("install-dependencies");
    expect(p.nonWaivable).toEqual(
      expect.arrayContaining(["untrusted-source", "destructive-commands", "secret-exposure"]),
    );
  });

  it("lower layers cannot weaken a deny set higher up", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "organization", policy: { network: "deny" } },
      { layer: "project", policy: { network: "allow", destructiveCommands: "allow" } },
      { layer: "task", policy: { reviewRequired: false } },
    ]);
    expect(p.network).toBe("deny");
    expect(p.destructiveCommands).toBe("deny");
    expect(p.provenance.network).toBe("organization");
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/project.*network.*ignored/),
        expect.stringMatching(/project.*destructiveCommands.*ignored/),
      ]),
    );
  });

  it("lower layers can strengthen", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "harness", policy: { network: "deny", requiredCheckIds: ["tests"] } },
      { layer: "task", policy: { reviewRequired: true, requiredCheckIds: ["typecheck"] } },
    ]);
    expect(p.network).toBe("deny");
    expect(p.provenance.network).toBe("harness");
    expect(p.reviewRequired).toBe(true);
    expect(p.requiredCheckIds).toEqual(["tests", "typecheck"]);
  });

  it("reviewRequired cannot be switched off by a lower layer", () => {
    const p = mergePolicies([
      { layer: "project", policy: { reviewRequired: true } },
      { layer: "task", policy: { reviewRequired: false } },
    ]);
    expect(p.reviewRequired).toBe(true);
    expect(p.warnings.join()).toMatch(/task.*reviewRequired.*ignored/);
  });

  it("allowedCommands lists intersect: argv[0] must match every list", () => {
    const p = mergePolicies([
      { layer: "organization", policy: { allowedCommands: ["pnpm", "node"] } },
      { layer: "project", policy: { allowedCommands: ["pnpm", "curl"] } },
    ]);
    expect(p.allowedCommands).toHaveLength(2);
  });

  it("waivable ids that any layer marks non-waivable are dropped", () => {
    const p = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "organization", policy: { nonWaivable: ["check:typecheck"] } },
      {
        layer: "harness",
        policy: { waivable: ["check:typecheck", "check:visual", "secret-exposure"] },
      },
    ]);
    expect(p.waivable).toEqual(["check:visual"]);
    expect(p.warnings.join("\n")).toMatch(/check:typecheck.*not waivable/);
    expect(p.warnings.join("\n")).toMatch(/secret-exposure.*not waivable/);
  });
});

describe("harnessLayer", () => {
  it("maps composed harness policies and waivable checks", () => {
    const layer = harnessLayer(
      { network: "deny", destructiveCommands: "deny", requireApprovalFor: ["modify-ci"] },
      [{ id: "visual", waivable: true }, { id: "tests", waivable: false }, { id: "lint" }],
    );
    expect(layer).toEqual({
      network: "deny",
      destructiveCommands: "deny",
      requireApprovalFor: ["modify-ci"],
      waivable: ["check:visual"],
    });
  });
});

describe("evaluateBefore", () => {
  const system = mergePolicies([{ layer: "system", policy: SYSTEM_POLICY }]);

  it("allows a clean plan", () => {
    const result = evaluateBefore(plan([check("tests", ["pnpm", "test"])]), system, [], ctx);
    expect(result.blocked).toEqual([]);
    expect(result.denied.size).toBe(0);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({ policy: "command", outcome: "allow", checkId: "tests" }),
    );
  });

  it("blocks untrusted harnesses with reason untrusted_source", () => {
    const result = evaluateBefore(
      plan([check("tests", ["pnpm", "test"])], { untrustedHarnesses: ["evil@1.0.0"] }),
      system,
      [],
      ctx,
    );
    expect(result.blocked).toEqual(["untrusted_source: evil@1.0.0"]);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({ policy: "untrusted-source", outcome: "deny", layer: "system" }),
    );
  });

  it("denies destructive commands, unsafe cwd and commands outside the allowlist", () => {
    const policy = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "project", policy: { allowedCommands: ["pnpm", "rm"] } },
    ]);
    const result = evaluateBefore(
      plan([
        check("wipe", ["rm", "-rf", "/"]),
        check("escape", ["pnpm", "test"], { cwd: "../.." }),
        check("curl", ["curl", "https://example.com"]),
      ]),
      policy,
      [],
      ctx,
    );
    expect([...result.denied.keys()].sort()).toEqual(["curl", "escape", "wipe"]);
    expect(result.blocked).toHaveLength(3);
    const policies = result.decisions.filter((d) => d.outcome === "deny").map((d) => d.policy);
    expect(policies.sort()).toEqual(["command-allowlist", "destructive-commands", "filesystem"]);
  });

  it("requires approval for dependency installation; an approval exception grants it", () => {
    const denied = evaluateBefore(plan([check("deps", ["pnpm", "install"])]), system, [], ctx);
    expect(denied.denied.get("deps")).toMatch(/approval/);
    expect(denied.decisions).toContainEqual(
      expect.objectContaining({ policy: "install-dependencies", outcome: "require_approval" }),
    );

    const approved = evaluateBefore(
      plan([check("deps", ["pnpm", "install"])]),
      system,
      [exception({ id: "appr-1", policy: "install-dependencies" })],
      ctx,
    );
    expect(approved.denied.size).toBe(0);
    expect(approved.decisions).toContainEqual(
      expect.objectContaining({
        policy: "install-dependencies",
        outcome: "approved",
        exceptionId: "appr-1",
      }),
    );
    expect(approved.applied.map((e) => e.id)).toEqual(["appr-1"]);
  });

  it("waives only waivable checks with a valid, in-scope, unexpired exception", () => {
    const policy = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "harness", policy: { waivable: ["check:visual"] } },
    ]);
    const checks = [check("visual", ["pnpm", "e2e"]), check("tests", ["pnpm", "test"])];
    const result = evaluateBefore(
      plan(checks),
      policy,
      [
        exception(),
        exception({ id: "exc-tests", policy: "check:tests" }),
        exception({ id: "exc-old", expiresAt: "2026-10-14T12:30:00Z" }),
        exception({ id: "exc-other-task", scope: { task: "UI-999" } }),
        exception({ id: "exc-other-project", scope: { project: "elsewhere" } }),
      ],
      ctx,
    );
    expect([...result.waived.entries()]).toEqual([["visual", "exception-001"]]);
    expect(result.applied).toEqual([
      expect.objectContaining({
        id: "exception-001",
        appliedTo: { task: "UI-142", harnesses: ["h@1.0.0"], checkId: "visual" },
      }),
    ]);
    const warnings = result.warnings.join("\n");
    expect(warnings).toMatch(/exc-tests.*check:tests.*not waivable/);
    expect(warnings).toMatch(/exc-old.*expired/);
    expect(warnings).toMatch(/exc-other-task.*scope/);
    expect(warnings).toMatch(/exc-other-project.*scope/);
  });

  it("an exception can never waive a security policy or untrusted source", () => {
    const policy = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "project", policy: { waivable: ["untrusted-source", "destructive-commands"] } },
    ]);
    const result = evaluateBefore(
      plan([check("wipe", ["rm", "-rf", "x"])], { untrustedHarnesses: ["evil@1.0.0"] }),
      policy,
      [
        exception({ id: "e1", policy: "untrusted-source", scope: {} }),
        exception({ id: "e2", policy: "destructive-commands", scope: {} }),
      ],
      ctx,
    );
    expect(result.blocked.length).toBeGreaterThanOrEqual(2);
    expect(result.applied).toEqual([]);
  });

  it("exceptions without task scope apply to any task; task-scoped ones need a task id", () => {
    const policy = mergePolicies([{ layer: "harness", policy: { waivable: ["check:visual"] } }]);
    const unscoped = evaluateBefore(
      plan([check("visual", ["x"])]),
      policy,
      [exception({ scope: {} })],
      { harnesses: [], now: NOW },
    );
    expect(unscoped.waived.get("visual")).toBe("exception-001");
    const scoped = evaluateBefore(plan([check("visual", ["x"])]), policy, [exception()], {
      harnesses: [],
      now: NOW,
    });
    expect(scoped.waived.size).toBe(0);
  });
});

describe("applyNetworkPolicy (best effort, no OS sandbox)", () => {
  it("deny points every proxy variable at an unreachable loopback and strips bypasses", () => {
    const env = applyNetworkPolicy("deny", {
      PATH: "/bin",
      NO_PROXY: "*",
      no_proxy: "*",
      HTTP_PROXY: "http://corp:8080",
    });
    expect(env.HTTP_PROXY).toBe(NETWORK_DENY_PROXY);
    expect(env.HTTPS_PROXY).toBe(NETWORK_DENY_PROXY);
    expect(env.http_proxy).toBe(NETWORK_DENY_PROXY);
    expect(env.https_proxy).toBe(NETWORK_DENY_PROXY);
    expect(env.ALL_PROXY).toBe(NETWORK_DENY_PROXY);
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("allow strips inherited proxy variables (never passes the caller's proxy credentials)", () => {
    const env = applyNetworkPolicy("allow", { PATH: "/bin", HTTPS_PROXY: "http://u:p@x" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("evaluateAfter", () => {
  const base = { required: true, cwd: ".", from: [], durationMs: 1, command: ["x"] };
  const system = mergePolicies([{ layer: "system", policy: SYSTEM_POLICY }]);

  it("blocks when any check output contained secrets", () => {
    const result = evaluateAfter(
      [{ ...base, id: "tests", state: "passed", secretFindings: 2 }],
      system,
      { exceptions: [], ctx },
    );
    expect(result.blocked).toEqual([
      "secret_exposure: 2 secret(s) in output of 'tests' (redacted)",
    ]);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({ policy: "secret-exposure", outcome: "deny", stage: "after" }),
    );
  });

  it("blocks when generated bundles contain secrets", () => {
    const result = evaluateAfter([{ ...base, id: "t", state: "passed" }], system, {
      exceptions: [],
      ctx,
      bundleFindings: [{ file: ".brokkr/generated/x/CLAUDE.md", findings: 1 }],
    });
    expect(result.blocked[0]).toMatch(/secret_exposure.*CLAUDE.md/);
  });

  it("required check ids that are missing are unmet unless waived", () => {
    const policy = mergePolicies([
      { layer: "system", policy: SYSTEM_POLICY },
      { layer: "project", policy: { requiredCheckIds: ["e2e", "t"], waivable: ["check:e2e"] } },
    ]);
    const unmet = evaluateAfter([{ ...base, id: "t", state: "passed" }], policy, {
      exceptions: [],
      ctx,
    });
    expect(unmet.unmet).toEqual(["required check 'e2e' is not defined by any selected harness"]);

    const waived = evaluateAfter([{ ...base, id: "t", state: "passed" }], policy, {
      exceptions: [exception({ id: "x-e2e", policy: "check:e2e" })],
      ctx,
    });
    expect(waived.unmet).toEqual([]);
    expect(waived.decisions).toContainEqual(
      expect.objectContaining({ policy: "check:e2e", outcome: "waived", exceptionId: "x-e2e" }),
    );
    expect(waived.applied.map((e) => e.id)).toEqual(["x-e2e"]);
  });

  it("review requirement is unmet without a review result and satisfied with one", () => {
    const policy = mergePolicies([{ layer: "project", policy: { reviewRequired: true } }]);
    const checks = [{ ...base, id: "t", state: "passed" as const }];
    expect(evaluateAfter(checks, policy, { exceptions: [], ctx }).unmet).toEqual([
      "review required by project policy but no review result was recorded",
    ]);
    expect(
      evaluateAfter(checks, policy, { exceptions: [], ctx, reviewRecorded: true }).unmet,
    ).toEqual([]);
  });
});

describe("loading policy files", () => {
  function dir(): string {
    return mkdtempSync(join(tmpdir(), "brokkr-policy-"));
  }

  it("loadOrgPolicy reads ~/.brokkr/org-policy.yaml when present", async () => {
    const home = dir();
    expect(await loadOrgPolicy(home)).toBeUndefined();
    mkdirSync(join(home, ".brokkr"));
    writeFileSync(join(home, ".brokkr", "org-policy.yaml"), "network: deny\n");
    expect(await loadOrgPolicy(home)).toEqual({ network: "deny" });
    writeFileSync(join(home, ".brokkr", "org-policy.yaml"), "network: sometimes\n");
    await expect(loadOrgPolicy(home)).rejects.toMatchObject({ code: "invalid-config" });
  });

  it("loadExceptions reads .brokkr/exceptions.yaml and rejects malformed records", async () => {
    const cwd = dir();
    expect(await loadExceptions(cwd)).toEqual([]);
    mkdirSync(join(cwd, ".brokkr"));
    writeFileSync(
      join(cwd, ".brokkr", "exceptions.yaml"),
      [
        "exceptions:",
        "  - id: exception-001",
        "    policy: check:visual",
        "    scope: { task: UI-142 }",
        "    reason: baseline missing",
        "    approvedBy: owner",
        "    approvedAt: 2026-10-14T12:00:00Z",
        "    expiresAt: 2026-10-15T12:00:00Z",
        "    evidence: [manual-review]",
        "",
      ].join("\n"),
    );
    const loaded = await loadExceptions(cwd);
    expect(loaded.map((e) => e.id)).toEqual(["exception-001"]);
    writeFileSync(join(cwd, ".brokkr", "exceptions.yaml"), "exceptions:\n  - id: x\n");
    await expect(loadExceptions(cwd)).rejects.toMatchObject({ code: "invalid-config" });
  });
});
