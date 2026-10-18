import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

export function tmp(prefix = "brokkr-reg-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface FixtureSkill {
  name: string;
  version?: string;
  dependsOn?: string[];
  conflictsWith?: string[];
  body?: string;
  tokens?: number;
}

export interface FixtureHarness {
  name: string;
  version?: string;
  dependsOn?: Array<{ name: string; version: string }>;
  conflictsWith?: string[];
  required?: string[];
  optional?: string[];
  skills?: FixtureSkill[];
  checks?: Array<Record<string, unknown>>;
  policies?: Record<string, unknown>;
  platforms?: string[];
  taskTypes?: string[];
  stages?: string[];
  brokkr?: string;
  evidence?: Record<string, boolean>;
  aiReview?: string[];
}

export function harnessManifest(h: FixtureHarness): Record<string, unknown> {
  return {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Harness",
    metadata: { name: h.name, version: h.version ?? "1.0.0", description: `${h.name} harness` },
    compatibility: {
      platforms: h.platforms ?? ["darwin", "linux", "win32"],
      taskTypes: h.taskTypes ?? ["general"],
      ...(h.brokkr ? { brokkr: h.brokkr } : {}),
    },
    ...(h.dependsOn ? { dependsOn: h.dependsOn } : {}),
    ...(h.conflictsWith ? { conflictsWith: h.conflictsWith } : {}),
    skills: { required: h.required ?? [], optional: h.optional ?? [] },
    workflow: { stages: h.stages ?? ["implement", "test"] },
    checks: h.checks ?? [
      { id: "tests", command: ["pnpm", "test"], required: true, timeoutSeconds: 60 },
    ],
    policies: h.policies ?? {
      network: "allow",
      destructiveCommands: "allow",
      requireApprovalFor: [],
    },
    evidence: h.evidence ?? {
      captureLogs: true,
      captureTestResults: false,
      captureScreenshots: false,
    },
    ...(h.aiReview ? { aiReview: { criteria: h.aiReview } } : {}),
  };
}

export function skillManifest(s: FixtureSkill): Record<string, unknown> {
  return {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Skill",
    metadata: {
      name: s.name,
      version: s.version ?? "1.0.0",
      description: `${s.name} skill`,
      tags: [],
    },
    ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
    ...(s.conflictsWith ? { conflictsWith: s.conflictsWith } : {}),
    selectors: {},
    body: "instructions.md",
    estimatedTokens: s.tokens ?? 100,
  };
}

/** Write a harness package into `parent/<dirName>`; skills listed in required/optional are created automatically. */
export function writeHarness(parent: string, h: FixtureHarness, dirName?: string): string {
  const dir = join(parent, dirName ?? `${h.name}-${h.version ?? "1.0.0"}`);
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "harness.yaml"), stringify(harnessManifest(h)));
  const skills = new Map<string, FixtureSkill>();
  for (const name of [...(h.required ?? []), ...(h.optional ?? [])]) skills.set(name, { name });
  for (const s of h.skills ?? []) skills.set(s.name, s);
  for (const s of skills.values()) {
    const sdir = join(dir, "skills", s.name);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, "skill.yaml"), stringify(skillManifest(s)));
    writeFileSync(
      join(sdir, "instructions.md"),
      s.body ?? `# ${s.name}\n\nGuidance for ${s.name}.\n`,
    );
  }
  return dir;
}
