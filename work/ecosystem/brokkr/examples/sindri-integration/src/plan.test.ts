import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planHarnesses } from "./plan.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sindri-example-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "vitest" }, dependencies: { react: "^19.0.0" } }),
  );
  return dir;
}

describe("Sindri-style planning with @brokkr/sdk", () => {
  it("resolves harnesses per planned task without running or writing anything", async () => {
    const cwd = repo();
    const home = mkdtempSync(join(tmpdir(), "sindri-example-home-"));
    const plan = await planHarnesses(
      cwd,
      [
        {
          id: "FE-1",
          title: "Build the scouting filters panel",
          description: "Responsive, accessible filters for the player list",
          taskTypes: ["frontend"],
        },
        {
          id: "QA-1",
          title: "Regression pass for the scouting filters",
          description: "Independent regression test plan and evidence",
          taskTypes: ["qa"],
        },
      ],
      home,
    );
    expect(plan.map((p) => [p.taskId, p.harnesses])).toEqual([
      ["FE-1", ["frontend-react@1.0.0"]],
      ["QA-1", ["qa-regression@1.0.0"]],
    ]);
    for (const p of plan) {
      expect(p.lockDigest).toMatch(/^sha256:/);
      expect(p.requiredChecks.length).toBeGreaterThan(0);
      expect(p.skills.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(cwd, ".brokkr"))).toBe(false);
  });
});
