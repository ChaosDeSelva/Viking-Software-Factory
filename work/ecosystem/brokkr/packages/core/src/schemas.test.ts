import { describe, expect, it } from "vitest";
import {
  CHECK_STATES,
  CheckStateSchema,
  HarnessLockSchema,
  HarnessManifestSchema,
  ProfileSchema,
  ProjectConfigSchema,
  SkillManifestSchema,
  TaskDescriptorSchema,
  VERDICTS,
  VerdictSchema,
  parseManifestText,
  validateWith,
} from "./index.js";

function validHarness(): Record<string, unknown> {
  return {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Harness",
    metadata: {
      name: "frontend-react",
      version: "1.0.0",
      description: "React engineering harness",
    },
    compatibility: { platforms: ["darwin", "linux"], taskTypes: ["frontend", "ui", "react"] },
    skills: { required: ["react-architecture"], optional: ["tailwind"] },
    workflow: { stages: ["inspect", "implement"] },
    checks: [
      {
        id: "typecheck",
        command: ["pnpm", "exec", "tsc", "--noEmit"],
        required: true,
        timeoutSeconds: 180,
      },
    ],
    policies: { network: "deny", destructiveCommands: "deny", requireApprovalFor: ["modify-ci"] },
    evidence: { captureLogs: true, captureTestResults: true, captureScreenshots: true },
  };
}

function issuePaths(input: unknown): string[] {
  const result = validateWith(HarnessManifestSchema, input);
  if (result.ok) return [];
  return result.issues.map((issue) => issue.path);
}

type Doc = Record<string, unknown>;
type Edit = (doc: Doc) => void;

/** Walk a dotted path (numeric segments index arrays) to its parent container. */
function parentOf(doc: Doc, path: string): [Record<string, unknown>, string] {
  const keys = path.split(".");
  let node: Record<string, unknown> = doc;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  return [node, keys[keys.length - 1]!];
}

const set =
  (path: string, value: unknown): Edit =>
  (doc) => {
    const [parent, key] = parentOf(doc, path);
    parent[key] = value;
  };

const del =
  (path: string): Edit =>
  (doc) => {
    const [parent, key] = parentOf(doc, path);
    delete parent[key];
  };

function mutate(...edits: Edit[]): Doc {
  const h = validHarness();
  for (const edit of edits) edit(h);
  return h;
}

describe("HarnessManifestSchema", () => {
  it("accepts the spec §5.2 example shape", () => {
    const result = validateWith(HarnessManifestSchema, validHarness());
    expect(result.ok).toBe(true);
  });

  it("accepts optional dependsOn, conflictsWith, brokkr range, check cwd/when and aiReview", () => {
    const h = mutate(
      set("compatibility.brokkr", ">=0.1.0"),
      set("dependsOn", [{ name: "security-baseline", version: "^1.0.0" }]),
      set("conflictsWith", ["frontend-vue"]),
      set("checks.0.cwd", "packages/web"),
      set("checks.0.when", { fileExists: ["tsconfig.json"], scriptExists: ["test"] }),
      set("aiReview", { criteria: ["architecture consistency"] }),
    );
    expect(validateWith(HarnessManifestSchema, h).ok).toBe(true);
  });

  const invalidCases: Array<[string, Edit, string]> = [
    ["apiVersion", set("apiVersion", "brokkr.dev/v2"), "apiVersion"],
    ["kind", set("kind", "Skill"), "kind"],
    ["metadata.name not kebab", set("metadata.name", "Frontend_React"), "metadata.name"],
    ["metadata.version not semver", set("metadata.version", "1.0"), "metadata.version"],
    ["metadata.description empty", set("metadata.description", ""), "metadata.description"],
    ["platform", set("compatibility.platforms", ["beos"]), "compatibility.platforms.0"],
    ["brokkr range", set("compatibility.brokkr", "not a range"), "compatibility.brokkr"],
    ["dependsOn version", set("dependsOn", [{ name: "x", version: "~~1" }]), "dependsOn.0.version"],
    ["dependsOn name", set("dependsOn", [{ name: "X Y", version: "^1.0.0" }]), "dependsOn.0.name"],
    ["skills.required", set("skills.required", "react"), "skills.required"],
    ["workflow.stages", set("workflow.stages", [1]), "workflow.stages.0"],
    ["command as shell string", set("checks.0.command", "pnpm test"), "checks.0.command"],
    ["command empty", set("checks.0.command", []), "checks.0.command"],
    ["command empty arg", set("checks.0.command", [""]), "checks.0.command.0"],
    ["check id", set("checks.0.id", "Type Check"), "checks.0.id"],
    ["required", set("checks.0.required", "yes"), "checks.0.required"],
    ["timeout negative", set("checks.0.timeoutSeconds", -1), "checks.0.timeoutSeconds"],
    ["timeout fractional", set("checks.0.timeoutSeconds", 1.5), "checks.0.timeoutSeconds"],
    ["cwd absolute", set("checks.0.cwd", "/etc"), "checks.0.cwd"],
    ["cwd traversal", set("checks.0.cwd", "a/../../b"), "checks.0.cwd"],
    ["when.fileExists", set("checks.0.when", { fileExists: "x" }), "checks.0.when.fileExists"],
    ["policies.network", set("policies.network", "maybe"), "policies.network"],
    [
      "policies.destructiveCommands",
      set("policies.destructiveCommands", true),
      "policies.destructiveCommands",
    ],
    ["evidence.captureLogs", set("evidence.captureLogs", "true"), "evidence.captureLogs"],
    ["unknown top-level key", set("extra", 1), ""],
    ["missing checks", del("checks"), "checks"],
    [
      "duplicate check ids",
      (h) => (h.checks as unknown[]).push({ ...(h.checks as Doc[])[0] }),
      "checks.1.id",
    ],
  ];

  it.each(invalidCases)("rejects invalid %s with the field path", (_label, fn, path) => {
    expect(issuePaths(mutate(fn))).toContain(path);
  });
});

describe("SkillManifestSchema", () => {
  const skill = {
    apiVersion: "brokkr.dev/v1alpha1",
    kind: "Skill",
    metadata: { name: "accessibility", version: "1.0.0", description: "A11y", tags: ["a11y"] },
    selectors: { taskTypes: ["frontend"], keywords: ["aria"], pathGlobs: ["src/**/*.tsx"] },
    body: "instructions.md",
    estimatedTokens: 800,
  };

  it("accepts a valid skill", () => {
    expect(validateWith(SkillManifestSchema, skill).ok).toBe(true);
  });

  it.each([
    ["body absolute", { body: "/etc/passwd" }, "body"],
    ["body traversal", { body: "../other/instructions.md" }, "body"],
    ["body not markdown", { body: "instructions.txt" }, "body"],
    ["estimatedTokens negative", { estimatedTokens: -5 }, "estimatedTokens"],
    ["kind", { kind: "Harness" }, "kind"],
    ["dependsOn", { dependsOn: ["Not Kebab"] }, "dependsOn.0"],
  ])("rejects %s", (_label, patch, path) => {
    const result = validateWith(SkillManifestSchema, { ...skill, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path)).toContain(path);
  });
});

describe("ProfileSchema / TaskDescriptorSchema / HarnessLockSchema / ProjectConfigSchema", () => {
  it("accepts a profile", () => {
    const profile = {
      name: "frontend-strict",
      harnesses: [{ name: "frontend-react", version: "^1.0.0" }],
    };
    expect(validateWith(ProfileSchema, profile).ok).toBe(true);
  });

  it("accepts a task and rejects path-unsafe ids", () => {
    const task = {
      id: "UI-142",
      title: "Build dashboard",
      description: "Create UI",
      tags: ["frontend"],
    };
    expect(validateWith(TaskDescriptorSchema, task).ok).toBe(true);
    const bad = validateWith(TaskDescriptorSchema, { ...task, id: "../escape" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.path).toBe("id");
  });

  it("requires lockVersion 2 and sha256 digests, with no exclusion lists", () => {
    const lock = {
      lockVersion: 2,
      generatedAt: "2026-10-14T00:00:00.000Z",
      harnesses: [
        {
          name: "frontend-react",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`,
          source: "builtin",
        },
      ],
      skills: [{ name: "typescript", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` }],
      adapters: [{ id: "claude-code", version: "0.1.0" }],
      digest: `sha256:${"c".repeat(64)}`,
    };
    expect(validateWith(HarnessLockSchema, lock).ok).toBe(true);
    expect(validateWith(HarnessLockSchema, { ...lock, lockVersion: 1 }).ok).toBe(false);
    const withExclusions = {
      ...lock,
      harnesses: [{ ...lock.harnesses[0]!, excluded: ["harness.yaml"] }],
    };
    expect(validateWith(HarnessLockSchema, withExclusions).ok).toBe(false);
    expect(validateWith(HarnessLockSchema, { ...lock, digest: "md5:abc" }).ok).toBe(false);
  });

  it("may pin a profile by name and digest (B3b fix round 2, N1)", () => {
    const lock = {
      lockVersion: 2,
      generatedAt: "2026-10-14T00:00:00.000Z",
      harnesses: [],
      skills: [],
      adapters: [],
      digest: `sha256:${"c".repeat(64)}`,
    };
    const profile = { name: "strict-x", digest: `sha256:${"d".repeat(64)}` };
    expect(validateWith(HarnessLockSchema, { ...lock, profile }).ok).toBe(true);
    expect(validateWith(HarnessLockSchema, { ...lock, profile: { name: "x" } }).ok).toBe(false);
  });

  it("accepts a project config with pinned external sources", () => {
    const config = {
      version: 1,
      harnesses: [{ name: "frontend-react", version: "^1.0.0" }],
      sources: [
        { path: "../vendor/harnesses", digest: `sha256:${"d".repeat(64)}`, trusted: false },
        { tarball: "vendor/h.tgz", digest: `sha256:${"e".repeat(64)}`, trusted: true },
      ],
    };
    expect(validateWith(ProjectConfigSchema, config).ok).toBe(true);
    const both = {
      ...config,
      sources: [{ path: "a", tarball: "b", digest: config.sources[0]!.digest, trusted: false }],
    };
    expect(validateWith(ProjectConfigSchema, both).ok).toBe(false);
  });
});

describe("check states and verdicts", () => {
  it("enumerates exactly the spec §8.2 states and verdicts", () => {
    expect(CHECK_STATES).toEqual([
      "passed",
      "failed",
      "errored",
      "skipped",
      "cancelled",
      "timed_out",
    ]);
    expect(VERDICTS).toEqual(["passed", "failed", "incomplete", "blocked"]);
    expect(CheckStateSchema.safeParse("timed_out").success).toBe(true);
    expect(VerdictSchema.safeParse("ok").success).toBe(false);
  });
});

describe("parseManifestText", () => {
  it("parses YAML and reports schema issues with file and path", () => {
    const yaml = "apiVersion: brokkr.dev/v1alpha1\nkind: Harness\nmetadata:\n  name: Bad Name\n";
    const result = parseManifestText(yaml, HarnessManifestSchema, "harness.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.path === "metadata.name" && i.file === "harness.yaml"),
      ).toBe(true);
    }
  });

  it("reports YAML syntax errors instead of throwing", () => {
    const result = parseManifestText("a: [unclosed", HarnessManifestSchema, "h.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/yaml/i);
  });

  it("parses JSON files by extension", () => {
    const result = parseManifestText(
      JSON.stringify(validHarness()),
      HarnessManifestSchema,
      "harness.json",
    );
    expect(result.ok).toBe(true);
  });
});
