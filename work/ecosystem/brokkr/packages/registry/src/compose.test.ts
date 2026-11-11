import { describe, expect, it } from "vitest";
import type { ComposedHarness } from "@brokkr/core";
import { Registry } from "./index.js";
import { layout, writeHarness, type FixtureHarness } from "../test/helpers.js";

async function compose(harnesses: FixtureHarness[]): Promise<ComposedHarness> {
  const l = layout();
  for (const h of harnesses) writeHarness(l.builtin, h);
  const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
  await registry.load();
  return registry.compose(
    registry.resolve({ harnesses: harnesses.map((h) => ({ name: h.name, range: "*" })) }),
  );
}

const check = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t",
  command: ["pnpm", "test"],
  required: false,
  timeoutSeconds: 60,
  ...extra,
});

describe("composeHarnessSet keeps the strictest check contract", () => {
  it("a check one harness makes required and non-waivable cannot be waived because another harness allows it", async () => {
    const composed = await compose([
      { name: "a", checks: [check({ waivable: true })] },
      { name: "b", checks: [check({ required: true })] },
    ]);
    expect(composed.checks).toHaveLength(1);
    expect(composed.checks[0]?.required).toBe(true);
    expect(composed.checks[0]?.waivable).toBe(false);
    expect(composed.checks[0]?.from).toEqual(["a@1.0.0", "b@1.0.0"]);
  });

  it("stays waivable only when every definition allows it", async () => {
    const both = await compose([
      { name: "a", checks: [check({ waivable: true })] },
      { name: "b", checks: [check({ waivable: true })] },
    ]);
    expect(both.checks[0]?.waivable).toBe(true);
    expect(both.warnings).toEqual([]);
    const later = await compose([
      { name: "a", checks: [check()] },
      { name: "b", checks: [check({ waivable: true })] },
    ]);
    expect(later.checks[0]?.waivable).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["env", { env: ["CI"] }, { env: ["CI", "DATABASE_URL"] }],
    ["parallel", { parallel: true }, {}],
    ["cwd", { cwd: "web" }, { cwd: "api" }],
    ["when", { when: { fileExists: ["a.json"] } }, { when: { fileExists: ["b.json"] } }],
  ])(
    "warns when a shared check id differs in %s and keeps the first definition",
    async (field, first, second) => {
      const composed = await compose([
        { name: "a", checks: [check(first)] },
        { name: "b", checks: [check(second)] },
      ]);
      expect(composed.warnings).toEqual([
        `check 't' is defined differently by a@1.0.0 and b@1.0.0 (${field}); using the definition from a@1.0.0`,
      ]);
      expect(composed.checks[0]).toMatchObject(first);
    },
  );

  it("identical definitions from two harnesses merge without a warning", async () => {
    const composed = await compose([
      { name: "a", checks: [check({ env: ["CI"] })] },
      { name: "b", checks: [check({ env: ["CI"] })] },
    ]);
    expect(composed.warnings).toEqual([]);
    expect(composed.checks.map((c) => [c.id, c.from])).toEqual([["t", ["a@1.0.0", "b@1.0.0"]]]);
  });
});

describe("composeHarnessSet policies, skills and evidence", () => {
  it("a deny from any harness wins regardless of order, and approvals are unioned and sorted", async () => {
    const open = { network: "allow", destructiveCommands: "allow", requireApprovalFor: ["push"] };
    const strict = {
      network: "deny",
      destructiveCommands: "deny",
      requireApprovalFor: ["install-dependencies", "push"],
    };
    for (const order of [
      [strict, open],
      [open, strict],
    ]) {
      const composed = await compose([
        { name: "a", policies: order[0]! },
        { name: "b", policies: order[1]! },
      ]);
      expect(composed.policies).toEqual({
        network: "deny",
        destructiveCommands: "deny",
        requireApprovalFor: ["install-dependencies", "push"],
      });
    }
  });

  it("a skill required by one harness is not listed as optional, and records who requires it", async () => {
    const composed = await compose([
      { name: "a", optional: ["shared", "extra"], aiReview: ["clear naming"] },
      { name: "b", required: ["shared"], stages: ["implement", "review"] },
    ]);
    expect(composed.skills).toEqual({ required: ["shared"], optional: ["extra"] });
    expect(composed.requiredBy).toEqual({ shared: ["b@1.0.0"] });
    expect(composed.workflow.stages).toEqual(["implement", "test", "review"]);
    expect(composed.aiReview.criteria).toEqual(["clear naming"]);
    expect(composed.executionAllowed).toBe(true);
  });
});
