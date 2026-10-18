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
import {
  inferTaskTypes,
  inspectRepo,
  recommendHarnesses,
  resolveSkills,
  scoreSkill,
} from "./index.js";

const NO_SIGNALS: RepoSignals = {
  packageManager: null,
  frameworks: [],
  scripts: [],
  hasTsconfig: false,
  testRunners: [],
};

function skill(
  name: string,
  opts: Partial<SkillManifest> & { selectors?: SkillManifest["selectors"] } = {},
): LoadedSkill {
  return {
    manifest: {
      apiVersion: "brokkr.dev/v1alpha1",
      kind: "Skill",
      metadata: {
        name,
        version: "1.0.0",
        description: `${name} skill`,
        tags: opts.metadata?.tags ?? [],
      },
      selectors: opts.selectors ?? {},
      body: "instructions.md",
      estimatedTokens: opts.estimatedTokens ?? 100,
      ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
      ...(opts.conflictsWith ? { conflictsWith: opts.conflictsWith } : {}),
    },
    dir: `/skills/${name}`,
    bodyPath: `/skills/${name}/instructions.md`,
    digest: `sha256:${"0".repeat(64)}`,
    providedBy: "fe@1.0.0",
  };
}

function harnessSet(
  required: string[],
  optional: string[],
  skills: LoadedSkill[],
  name = "fe",
): ResolvedHarnessSet {
  const manifest = {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Harness",
    metadata: { name, version: "1.0.0", description: "x" },
    compatibility: { platforms: ["linux"], taskTypes: ["frontend"] },
    skills: { required, optional },
    workflow: { stages: [] },
    checks: [],
    policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: [] },
    evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: false },
  } as HarnessManifest;
  const harness: ResolvedHarness = {
    manifest,
    dir: "/h",
    digest: `sha256:${"1".repeat(64)}`,
    source: "builtin",
    sourceRef: "builtin",
    trust: "trusted",
    skills,
    executionAllowed: true,
    requestedBy: ["request"],
  };
  return {
    harnesses: [harness],
    skills: Object.fromEntries(skills.map((s) => [s.manifest.metadata.name, s])),
  };
}

const task: TaskDescriptor = {
  id: "UI-142",
  title: "Build analytics dashboard",
  description: "Create a responsive analytics UI with an accessible chart component",
  tags: ["frontend", "react"],
  paths: ["src/components/Chart.tsx"],
};

function catalog(): ResolvedHarnessSet {
  return harnessSet(
    ["react-architecture", "typescript"],
    ["tailwind", "component-design", "performance", "backend-only"],
    [
      skill("react-architecture", { estimatedTokens: 900 }),
      skill("typescript", { estimatedTokens: 500 }),
      skill("tailwind", {
        selectors: { keywords: ["tailwind"] },
        metadata: { tags: ["tailwind"] } as never,
      }),
      skill("component-design", {
        selectors: {
          taskTypes: ["ui"],
          keywords: ["component", "dashboard"],
          pathGlobs: ["src/components/**"],
        },
        dependsOn: ["react-architecture"],
        estimatedTokens: 450,
      }),
      skill("performance", {
        selectors: { keywords: ["responsive", "slow"] },
        estimatedTokens: 400,
      }),
      skill("backend-only", { selectors: { taskTypes: ["backend"] } }),
    ],
  );
}

describe("scoreSkill", () => {
  it("scores task types, keywords and path globs with reasons", () => {
    const s = skill("component-design", {
      selectors: {
        taskTypes: ["frontend"],
        keywords: ["component", "dashboard"],
        pathGlobs: ["src/components/**"],
      },
    });
    const result = scoreSkill(s.manifest, task, NO_SIGNALS);
    expect(result.score).toBe(3 + 2 + 2 + 2);
    expect(result.reasons).toEqual([
      "task type 'frontend'",
      "keyword 'component' in task",
      "keyword 'dashboard' in task",
      "path 'src/components/Chart.tsx' matches 'src/components/**'",
    ]);
  });

  it("matches keywords on word boundaries only", () => {
    const s = skill("x", { selectors: { keywords: ["ui"] } });
    expect(
      scoreSkill(
        s.manifest,
        { ...task, title: "Build", description: "guide", tags: [] },
        NO_SIGNALS,
      ).score,
    ).toBe(0);
  });

  it("adds a small boost for repository signals matching skill tags", () => {
    const s = skill("tailwind", { metadata: { tags: ["tailwind"] } as never });
    const result = scoreSkill(s.manifest, task, { ...NO_SIGNALS, frameworks: ["tailwind"] });
    expect(result.score).toBe(1);
  });
});

describe("resolveSkills", () => {
  it("always includes required skills and selects matching optional skills with reasons", async () => {
    const result = await resolveSkills({ task, harnesses: catalog(), repoSignals: NO_SIGNALS });
    expect(result.skills.map((s) => s.name)).toEqual([
      "react-architecture",
      "typescript",
      "component-design",
      "performance",
    ]);
    const required = result.skills[0]!;
    expect(required).toMatchObject({
      selected: true,
      requiredBy: "fe@1.0.0",
      reason: "required by fe@1.0.0",
    });
    const cd = result.skills.find((s) => s.name === "component-design")!;
    expect(cd.reason).toMatch(/keyword 'component'/);
    expect(cd.requiredBy).toBeUndefined();
    expect(result.rationale).toEqual([
      {
        name: "backend-only",
        reason: "no selector matched the task (score 0, threshold 2)",
        score: 0,
      },
      { name: "tailwind", reason: "no selector matched the task (score 0, threshold 2)", score: 0 },
    ]);
  });

  it("is deterministic", async () => {
    const a = await resolveSkills({ task, harnesses: catalog(), repoSignals: NO_SIGNALS });
    const b = await resolveSkills({ task, harnesses: catalog(), repoSignals: NO_SIGNALS });
    expect(b).toEqual(a);
  });

  it("repository signals alone do not select an optional skill", async () => {
    const result = await resolveSkills({
      task: { id: "T", title: "Fix a bug", description: "" },
      harnesses: catalog(),
      repoSignals: { ...NO_SIGNALS, frameworks: ["tailwind"] },
    });
    expect(result.skills.map((s) => s.name)).toEqual(["react-architecture", "typescript"]);
  });

  it("pulls in skill dependencies with a dependency reason", async () => {
    const set = harnessSet(
      [],
      ["a"],
      [skill("a", { selectors: { keywords: ["dashboard"] }, dependsOn: ["b"] }), skill("b")],
    );
    const result = await resolveSkills({ task, harnesses: set, repoSignals: NO_SIGNALS });
    expect(result.skills.map((s) => [s.name, s.reason])).toEqual([
      ["a", "keyword 'dashboard' in task"],
      ["b", "dependency of a"],
    ]);
  });

  it("errors on conflicting selected skills", async () => {
    const set = harnessSet(
      ["a"],
      ["b"],
      [
        skill("a", { conflictsWith: ["b"] }),
        skill("b", { selectors: { keywords: ["dashboard"] } }),
      ],
    );
    await expect(
      resolveSkills({ task, harnesses: set, repoSignals: NO_SIGNALS }),
    ).rejects.toMatchObject({
      code: "skill-conflict",
    });
  });

  it("errors on a dependency missing from the catalog", async () => {
    const set = harnessSet(["a"], [], [skill("a", { dependsOn: ["ghost"] })]);
    await expect(
      resolveSkills({ task, harnesses: set, repoSignals: NO_SIGNALS }),
    ).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("drops optional skills lowest score first to fit the budget", async () => {
    // required = 900 + 500 = 1400; component-design (score 9) 450; performance (score 2) 400.
    const result = await resolveSkills({
      task,
      harnesses: catalog(),
      repoSignals: NO_SIGNALS,
      budgetTokens: 1900,
    });
    expect(result.skills.map((s) => s.name)).toEqual([
      "react-architecture",
      "typescript",
      "component-design",
    ]);
    expect(result.rationale).toContainEqual({
      name: "performance",
      reason: "dropped to fit the context budget of 1900 tokens",
      score: 2,
    });
    expect(result.budget).toEqual({ limit: 1900, used: 1850, exceeded: false });
  });

  it("never drops required skills even when they alone exceed the budget", async () => {
    const result = await resolveSkills({
      task,
      harnesses: catalog(),
      repoSignals: NO_SIGNALS,
      budgetTokens: 10,
    });
    expect(result.skills.map((s) => s.name)).toEqual(["react-architecture", "typescript"]);
    expect(result.budget).toEqual({ limit: 10, used: 1400, exceeded: true });
  });

  it("never drops a dependency of a required skill during trimming", async () => {
    const set = harnessSet(
      ["a"],
      ["o"],
      [
        skill("a", { dependsOn: ["dep"], estimatedTokens: 10 }),
        skill("dep", { estimatedTokens: 10 }),
        skill("o", { selectors: { keywords: ["dashboard"] }, estimatedTokens: 10 }),
      ],
    );
    const result = await resolveSkills({
      task,
      harnesses: set,
      repoSignals: NO_SIGNALS,
      budgetTokens: 5,
    });
    expect(result.skills.map((s) => [s.name, s.requiredBy])).toEqual([
      ["a", "fe@1.0.0"],
      ["dep", "fe@1.0.0"],
    ]);
  });
});

describe("AI suggestion hook", () => {
  it("can add a permitted optional skill", async () => {
    const result = await resolveSkills({
      task,
      harnesses: catalog(),
      repoSignals: NO_SIGNALS,
      suggest: async () => ["tailwind"],
    });
    const tailwind = result.skills.find((s) => s.name === "tailwind");
    expect(tailwind?.reason).toBe("AI-suggested optional skill");
  });

  it("cannot add a skill outside the harness set or remove a required one", async () => {
    let seen: unknown;
    const result = await resolveSkills({
      task,
      harnesses: catalog(),
      repoSignals: NO_SIGNALS,
      suggest: async (ctx) => {
        seen = ctx;
        return ["evil-skill", "shell-access"];
      },
    });
    const names = result.skills.map((s) => s.name);
    expect(names).not.toContain("evil-skill");
    expect(names).not.toContain("shell-access");
    expect(names).toEqual(expect.arrayContaining(["react-architecture", "typescript"]));
    expect(result.rationale).toContainEqual({
      name: "evil-skill",
      reason: "AI suggestion rejected: not an optional skill of the resolved harnesses",
    });
    expect((seen as { candidates: string[] }).candidates).toEqual(["backend-only", "tailwind"]);
  });

  it("AI suggestions are trimmed by the budget like any optional skill and errors are contained", async () => {
    const result = await resolveSkills({
      task,
      harnesses: catalog(),
      repoSignals: NO_SIGNALS,
      budgetTokens: 1400,
      suggest: async () => {
        throw new Error("model offline");
      },
    });
    expect(result.skills.map((s) => s.name)).toEqual(["react-architecture", "typescript"]);
    expect(result.warnings).toEqual(["AI suggestion hook failed: model offline"]);
  });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "brokkr-repo-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("inspectRepo", () => {
  it("detects a pnpm React + Vite + TypeScript repo", async () => {
    const dir = repo({
      "package.json": JSON.stringify({
        scripts: { build: "vite build", test: "vitest", dev: "vite" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: {
          vite: "^7.0.0",
          vitest: "^4.0.0",
          tailwindcss: "^4.0.0",
          "@playwright/test": "^1.0.0",
        },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "tsconfig.json": "{}",
    });
    expect(await inspectRepo(dir)).toEqual({
      packageManager: "pnpm",
      frameworks: ["react", "tailwind", "vite"],
      scripts: ["build", "dev", "test"],
      hasTsconfig: true,
      testRunners: ["playwright", "vitest"],
    });
  });

  it.each([
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
  ])("detects %s as %s", async (file, pm) => {
    const dir = repo({
      "package.json": JSON.stringify({ dependencies: { fastify: "^5", express: "^5" } }),
      [file]: "",
    });
    const signals = await inspectRepo(dir);
    expect(signals.packageManager).toBe(pm);
    expect(signals.frameworks).toEqual(["express", "fastify"]);
  });

  it("detects next, jest and mocha", async () => {
    const dir = repo({
      "package.json": JSON.stringify({
        dependencies: { next: "15" },
        devDependencies: { jest: "1", mocha: "1" },
      }),
    });
    const signals = await inspectRepo(dir);
    expect(signals.frameworks).toEqual(["next"]);
    expect(signals.testRunners).toEqual(["jest", "mocha"]);
  });

  it("detects Spring via build.gradle and Godot via project.godot", async () => {
    const dir = repo({
      "build.gradle.kts":
        'plugins { id("org.springframework.boot") version "3.3.0" }\ntestImplementation("org.junit.jupiter:junit-jupiter")\n',
      "project.godot": "[application]\n",
    });
    const signals = await inspectRepo(dir);
    expect(signals.packageManager).toBe("gradle");
    expect(signals.frameworks).toEqual(["godot", "spring"]);
    expect(signals.testRunners).toEqual(["junit"]);
  });

  it("handles an empty directory and malformed package.json", async () => {
    expect(await inspectRepo(repo({}))).toEqual(NO_SIGNALS);
    expect((await inspectRepo(repo({ "package.json": "{not json" }))).frameworks).toEqual([]);
  });
});

describe("recommendHarnesses", () => {
  const manifest = (name: string, taskTypes: string[], version = "1.0.0") =>
    ({
      metadata: { name, version, description: `${name} harness` },
      compatibility: { platforms: ["linux"], taskTypes },
    }) as HarnessManifest;

  it("infers task types from frameworks", () => {
    expect(inferTaskTypes({ ...NO_SIGNALS, frameworks: ["react", "vite"] })).toEqual([
      "frontend",
      "react",
      "ui",
    ]);
    expect(inferTaskTypes({ ...NO_SIGNALS, frameworks: ["fastify"] })).toEqual([
      "api",
      "backend",
      "node",
    ]);
    expect(inferTaskTypes({ ...NO_SIGNALS, frameworks: ["godot"] })).toEqual(["game", "godot"]);
  });

  it("recommends harnesses whose task types match the repository", () => {
    const recs = recommendHarnesses(
      [
        manifest("frontend-react", ["frontend", "ui", "react"]),
        manifest("backend-node", ["backend", "api", "node"]),
        manifest("frontend-react", ["frontend"], "0.9.0"),
      ],
      { ...NO_SIGNALS, frameworks: ["react", "vite"] },
    );
    expect(recs).toEqual([
      {
        name: "frontend-react",
        version: "1.0.0",
        matchedTaskTypes: ["frontend", "react", "ui"],
        reason: "repository uses react, vite; harness covers task types frontend, react, ui",
        description: "frontend-react harness",
      },
    ]);
  });
});

describe("review M9", () => {
  it("a low-scoring optional skill pulled in as a dependency is not also listed as rejected", async () => {
    const set = harnessSet(["a"], ["b"], [skill("a", { dependsOn: ["b"] }), skill("b")]);
    const result = await resolveSkills({ task, harnesses: set, repoSignals: NO_SIGNALS });
    expect(result.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(result.rationale).toEqual([]);
  });
});
