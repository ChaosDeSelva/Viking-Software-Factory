import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import type { HarnessManifest, RepoSignals } from "@brokkr/core";

const FRAMEWORK_DEPS: Record<string, string> = {
  react: "react",
  vite: "vite",
  next: "next",
  fastify: "fastify",
  express: "express",
  tailwindcss: "tailwind",
};
const TEST_RUNNER_DEPS: Record<string, string> = {
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  "@playwright/test": "playwright",
  playwright: "playwright",
  cypress: "cypress",
};
const LOCKFILES: Array<[string, NonNullable<RepoSignals["packageManager"]>]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
const GRADLE_FILES = ["build.gradle", "build.gradle.kts"];

async function readText(file: string): Promise<string | undefined> {
  return existsSync(file) ? readFile(file, "utf8") : undefined;
}

/** Inspect a repository for package manager, frameworks, scripts, tsconfig and test runners. Read-only. */
export async function inspectRepo(cwd: string): Promise<RepoSignals> {
  const frameworks = new Set<string>();
  const testRunners = new Set<string>();
  let scripts: string[] = [];
  let packageManager: RepoSignals["packageManager"] =
    LOCKFILES.find(([f]) => existsSync(join(cwd, f)))?.[1] ?? null;

  const pkgText = await readText(join(cwd, "package.json"));
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        packageManager?: string;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of Object.keys(deps)) {
        const fw = FRAMEWORK_DEPS[dep];
        if (fw) frameworks.add(fw);
        const tr = TEST_RUNNER_DEPS[dep];
        if (tr) testRunners.add(tr);
      }
      scripts = Object.keys(pkg.scripts ?? {}).sort();
      if (packageManager === null && typeof pkg.packageManager === "string") {
        const pm = pkg.packageManager.split("@")[0];
        if (pm === "pnpm" || pm === "npm" || pm === "yarn" || pm === "bun") packageManager = pm;
      }
    } catch {
      // Malformed package.json: report no signals from it rather than failing inspection.
    }
  }

  for (const file of GRADLE_FILES) {
    const text = await readText(join(cwd, file));
    if (text === undefined) continue;
    packageManager ??= "gradle";
    if (text.includes("org.springframework.boot")) frameworks.add("spring");
    if (/junit/i.test(text)) testRunners.add("junit");
  }
  if (existsSync(join(cwd, "project.godot"))) frameworks.add("godot");

  return {
    packageManager,
    frameworks: [...frameworks].sort(),
    scripts,
    hasTsconfig: existsSync(join(cwd, "tsconfig.json")),
    testRunners: [...testRunners].sort(),
  };
}

const TASK_TYPES_BY_FRAMEWORK: Record<string, string[]> = {
  react: ["frontend", "ui", "react"],
  next: ["frontend", "ui", "react"],
  vite: ["frontend", "ui"],
  fastify: ["backend", "api", "node"],
  express: ["backend", "api", "node"],
  spring: ["backend", "kotlin", "spring"],
  godot: ["game", "godot"],
};

/** Map repository signals to harness task types. */
export function inferTaskTypes(signals: RepoSignals): string[] {
  const out = new Set<string>();
  for (const fw of signals.frameworks)
    for (const t of TASK_TYPES_BY_FRAMEWORK[fw] ?? []) out.add(t);
  return [...out].sort();
}

export interface HarnessRecommendation {
  name: string;
  version: string;
  description: string;
  matchedTaskTypes: string[];
  reason: string;
}

/** Recommend harnesses (highest version per name) whose `compatibility.taskTypes` match the repository. */
export function recommendHarnesses(
  manifests: ReadonlyArray<Pick<HarnessManifest, "metadata" | "compatibility">>,
  signals: RepoSignals,
): HarnessRecommendation[] {
  const inferred = new Set(inferTaskTypes(signals));
  const latest = new Map<string, Pick<HarnessManifest, "metadata" | "compatibility">>();
  for (const m of manifests) {
    const current = latest.get(m.metadata.name);
    if (!current || semver.gt(m.metadata.version, current.metadata.version))
      latest.set(m.metadata.name, m);
  }
  const recs: HarnessRecommendation[] = [];
  for (const m of latest.values()) {
    const matched = m.compatibility.taskTypes.filter((t) => inferred.has(t)).sort();
    if (matched.length === 0) continue;
    recs.push({
      name: m.metadata.name,
      version: m.metadata.version,
      description: m.metadata.description,
      matchedTaskTypes: matched,
      reason: `repository uses ${signals.frameworks.join(", ")}; harness covers task types ${matched.join(", ")}`,
    });
  }
  return recs.sort(
    (a, b) => b.matchedTaskTypes.length - a.matchedTaskTypes.length || a.name.localeCompare(b.name),
  );
}
