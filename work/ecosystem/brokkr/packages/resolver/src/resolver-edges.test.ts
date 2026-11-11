import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HarnessManifest,
  LoadedSkill,
  RepoSignals,
  ResolvedHarness,
  ResolvedHarnessSet,
  SkillManifest,
  TaskDescriptor,
} from "@brokkr/core";
import { inferTaskTypes, inspectRepo, recommendHarnesses, resolveSkills } from "./index.js";

const NO_SIGNALS: RepoSignals = {
  packageManager: null,
  frameworks: [],
  scripts: [],
  hasTsconfig: false,
  testRunners: [],
};

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "brokkr-resolver-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function skill(name: string, opts: Partial<SkillManifest> = {}): LoadedSkill {
  return {
    manifest: {
      apiVersion: "brokkr.dev/v1alpha1",
      kind: "Skill",
      metadata: { name, version: "1.0.0", description: `${name} skill`, tags: [] },
      selectors: opts.selectors ?? {},
      body: "instructions.md",
      estimatedTokens: opts.estimatedTokens ?? 100,
      ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
      ...(opts.conflictsWith ? { conflictsWith: opts.conflictsWith } : {}),
    },
    dir: `/skills/${name}`,
    bodyPath: `/skills/${name}/instructions.md`,
    digest: `sha256:${"0".repeat(64)}`,
    providedBy: "h@1.0.0",
  };
}

function harness(name: string, required: string[], optional: string[]): ResolvedHarness {
  return {
    manifest: {
      apiVersion: "brokkr.dev/v1alpha1",
      kind: "Harness",
      metadata: { name, version: "1.0.0", description: "x" },
      compatibility: { platforms: ["linux"], taskTypes: ["frontend"] },
      skills: { required, optional },
      workflow: { stages: [] },
      checks: [],
      policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: [] },
      evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: false },
    } as HarnessManifest,
    dir: "/h",
    digest: `sha256:${"1".repeat(64)}`,
    source: "builtin",
    sourceRef: "builtin",
    trust: "trusted",
    skills: [],
    executionAllowed: true,
    requestedBy: ["request"],
  };
}

function set(harnesses: ResolvedHarness[], skills: LoadedSkill[]): ResolvedHarnessSet {
  return {
    harnesses,
    skills: Object.fromEntries(skills.map((s) => [s.manifest.metadata.name, s])),
  };
}

const task: TaskDescriptor = { id: "T", title: "Fix the chart", description: "", tags: [] };

describe("inspectRepo edges", () => {
  it("uses package.json packageManager when there is no lockfile", async () => {
    expect(
      (
        await inspectRepo(
          repo({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0" }) }),
        )
      ).packageManager,
    ).toBe("yarn");
    expect(
      (await inspectRepo(repo({ "package.json": JSON.stringify({ packageManager: "deno@2" }) })))
        .packageManager,
    ).toBeNull();
    expect(
      (
        await inspectRepo(
          repo({ "package.json": JSON.stringify({ packageManager: "yarn@4" }), "bun.lockb": "" }),
        )
      ).packageManager,
    ).toBe("bun");
  });

  it("a lockfile keeps precedence over gradle, and a plain gradle build adds no framework", async () => {
    const signals = await inspectRepo(
      repo({ "package-lock.json": "{}", "build.gradle": "plugins { id 'java' }\n" }),
    );
    expect(signals).toEqual({ ...NO_SIGNALS, packageManager: "npm" });
  });

  it("a package.json or build file that is a directory is ignored, not a crash", async () => {
    const dir = repo({});
    mkdirSync(join(dir, "package.json"));
    mkdirSync(join(dir, "build.gradle"));
    expect(await inspectRepo(dir)).toEqual(NO_SIGNALS);
  });
});

describe("inferTaskTypes / recommendHarnesses edges", () => {
  it("frameworks without task types contribute none", () => {
    expect(inferTaskTypes({ ...NO_SIGNALS, frameworks: ["tailwind"] })).toEqual([]);
  });

  it("orders recommendations by matched task types, then by name", () => {
    const m = (name: string, taskTypes: string[]) =>
      ({
        metadata: { name, version: "1.0.0", description: name },
        compatibility: { platforms: ["linux"], taskTypes },
      }) as HarnessManifest;
    const recs = recommendHarnesses(
      [m("zeta", ["frontend"]), m("alpha", ["frontend"]), m("both", ["frontend", "ui"])],
      { ...NO_SIGNALS, frameworks: ["vite"] },
    );
    expect(recs.map((r) => r.name)).toEqual(["both", "alpha", "zeta"]);
  });
});

describe("resolveSkills edges", () => {
  it("a skill required by two harnesses and optional in one is selected once, as required", async () => {
    const result = await resolveSkills({
      task,
      repoSignals: NO_SIGNALS,
      harnesses: set(
        [harness("a", ["ts"], ["lint"]), harness("b", ["ts"], ["ts", "lint"])],
        [skill("ts"), skill("lint")],
      ),
    });
    expect(result.skills.map((s) => [s.name, s.requiredBy])).toEqual([["ts", "a@1.0.0"]]);
    expect(result.rationale.map((r) => r.name)).toEqual(["lint"]);
  });

  it("a required skill missing from the catalog is a not-found error", async () => {
    await expect(
      resolveSkills({
        task,
        repoSignals: NO_SIGNALS,
        harnesses: set([harness("a", ["ghost"], [])], []),
      }),
    ).rejects.toThrow("skill 'ghost' (needed by ghost) is not provided by the resolved harnesses");
  });

  it("ignores AI suggestions of skills that are already selected", async () => {
    const result = await resolveSkills({
      task,
      repoSignals: NO_SIGNALS,
      harnesses: set(
        [harness("a", ["ts"], ["chart", "other"])],
        [skill("ts"), skill("chart", { selectors: { keywords: ["chart"] } }), skill("other")],
      ),
      suggest: () => Promise.resolve(["ts", "chart"]),
    });
    expect(result.skills.map((s) => s.name)).toEqual(["ts", "chart"]);
    expect(result.rationale).toEqual([
      expect.objectContaining({ name: "other", reason: expect.stringMatching(/no selector/) }),
    ]);
  });

  it("on equal scores the budget drops the alphabetically later skill first", async () => {
    const result = await resolveSkills({
      task: { ...task, title: "chart table" },
      repoSignals: NO_SIGNALS,
      harnesses: set(
        [harness("a", [], ["b-chart", "a-table"])],
        [
          skill("b-chart", { selectors: { keywords: ["chart"] } }),
          skill("a-table", { selectors: { keywords: ["table"] } }),
        ],
      ),
      budgetTokens: 150,
    });
    expect(result.skills.map((s) => s.name)).toEqual(["a-table"]);
    expect(result.rationale).toEqual([
      expect.objectContaining({ name: "b-chart", reason: expect.stringMatching(/budget of 150/) }),
    ]);
  });

  it("a conflict with a skill that is not selected is no error", async () => {
    const result = await resolveSkills({
      task,
      repoSignals: NO_SIGNALS,
      harnesses: set(
        [harness("a", ["ts"], ["js"])],
        [skill("ts", { conflictsWith: ["js"] }), skill("js")],
      ),
    });
    expect(result.skills.map((s) => s.name)).toEqual(["ts"]);
  });
});
