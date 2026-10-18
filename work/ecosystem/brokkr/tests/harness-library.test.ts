import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileSchema, parseManifestText } from "../packages/core/src/index.ts";
import { Registry, validateHarnessDir } from "../packages/registry/src/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESSES = join(ROOT, "harnesses");
const P0 = [
  "frontend-react",
  "backend-node",
  "security-baseline",
  "documentation",
  "qa-regression",
];
const P1 = ["database-postgres", "backend-kotlin-spring", "godot-game"];
const ALL = [...P0, ...P1];
const PROFILES = ["frontend-strict", "backend-strict", "fullstack"];

const harnessDirs = readdirSync(HARNESSES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "profiles")
  .map((e) => e.name)
  .sort();

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

describe("built-in harness library", () => {
  it("ships exactly the expected harnesses", () => {
    expect(harnessDirs).toEqual([...ALL].sort());
  });

  describe.each(ALL)("%s", (name) => {
    const dir = join(HARNESSES, name);

    it("validates with no issues or warnings", async () => {
      const result = await validateHarnessDir(dir);
      expect(result.issues).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.manifest?.metadata.name).toBe(name);
    });

    it("has README, brief template with all placeholders, and parseable roles", () => {
      expect(existsSync(join(dir, "README.md"))).toBe(true);
      const brief = readFileSync(join(dir, "templates/brief.md"), "utf8");
      for (const p of ["objective", "acceptanceCriteria", "context", "constraints"]) {
        expect(brief).toContain(`{{${p}}}`);
      }
      const roles = readdirSync(join(dir, "roles")).filter((f) => f.endsWith(".yaml"));
      expect(roles.length).toBeGreaterThan(0);
    });

    it("has argv-array checks with sane shape", async () => {
      const { manifest } = await validateHarnessDir(dir);
      for (const check of manifest?.checks ?? []) {
        expect(Array.isArray(check.command)).toBe(true);
        expect(check.command.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
      }
      expect(manifest?.policies.network).toBe("deny");
      expect(manifest?.policies.destructiveCommands).toBe("deny");
    });

    it("skill bodies are concise Always/Never/Verify rules", async () => {
      const result = await validateHarnessDir(dir);
      const skills = result.pkg?.skills ?? [];
      expect(skills.length).toBeGreaterThan(0);
      for (const skill of skills) {
        const body = readFileSync(skill.bodyPath, "utf8");
        const label = `${name}/${skill.manifest.metadata.name}`;
        expect(words(body), `${label} word count`).toBeLessThanOrEqual(300);
        for (const heading of ["Always", "Never", "Verify"]) {
          expect(body, `${label} needs a '${heading}' section`).toMatch(
            new RegExp(`^#{2,3} ${heading}\\s*$`, "m"),
          );
        }
        expect(skill.manifest.metadata.description.length).toBeLessThanOrEqual(1024);
      }
    });
  });

  it.each(P0)("P0 harness %s has >= 3 checks and >= 4 required skills", async (name) => {
    const { manifest } = await validateHarnessDir(join(HARNESSES, name));
    expect(manifest?.checks.length).toBeGreaterThanOrEqual(3);
    expect(manifest?.skills.required.length).toBeGreaterThanOrEqual(4);
  });

  it("frontend-react covers the specified skills, checks and policies", async () => {
    const { manifest } = await validateHarnessDir(join(HARNESSES, "frontend-react"));
    const skills = [...(manifest?.skills.required ?? []), ...(manifest?.skills.optional ?? [])];
    for (const s of [
      "react-architecture",
      "typescript",
      "accessibility",
      "tailwind",
      "responsive-design",
      "component-reuse",
      "playwright",
      "visual-qa",
    ]) {
      expect(skills).toContain(s);
    }
    const checks = manifest?.checks ?? [];
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(
      byId.get("typecheck")?.when?.scriptExists ?? byId.get("typecheck")?.when?.fileExists,
    ).toBeDefined();
    expect(byId.get("lint")?.when?.scriptExists).toEqual(["lint"]);
    expect(byId.get("unit")?.when?.scriptExists).toEqual(["test"]);
    const desktop = byId.get("screenshot-desktop");
    const mobile = byId.get("screenshot-mobile");
    expect(desktop?.command.join(" ")).toContain("1280x800");
    expect(mobile?.command.join(" ")).toContain("390x844");
    expect(byId.has("axe")).toBe(true);
    expect(manifest?.policies.requireApprovalFor).toEqual(
      expect.arrayContaining(["install-dependencies", "modify-ci"]),
    );
  });

  it("backend-node, database, kotlin and godot checks are conditional on the right signals", async () => {
    const load = async (n: string) => (await validateHarnessDir(join(HARNESSES, n))).manifest;
    const backend = await load("backend-node");
    for (const s of [
      "api-contracts",
      "input-validation",
      "authn-authz-review",
      "error-handling",
      "structured-logging",
      "testing",
      "backend-performance",
    ]) {
      expect([...(backend?.skills.required ?? []), ...(backend?.skills.optional ?? [])]).toContain(
        s,
      );
    }
    const mig = backend?.checks.find((c) => c.id === "migration-dry-run");
    expect(mig?.when?.fileExists?.some((p) => p.includes("migrations"))).toBe(true);
    const pg = await load("database-postgres");
    expect(pg?.checks.find((c) => c.id === "migration-dry-run")?.when?.fileExists).toBeDefined();
    expect(pg?.checks.some((c) => c.command[0] === "sqlfluff")).toBe(true);
    const kt = await load("backend-kotlin-spring");
    expect(
      kt?.checks.find((c) => c.command.join(" ") === "./gradlew test")?.when?.fileExists,
    ).toEqual(["gradlew"]);
    const godot = await load("godot-game");
    expect(
      godot?.checks.find((c) => c.command.join(" ").startsWith("godot --headless --check-only"))
        ?.when?.fileExists,
    ).toEqual(["project.godot", "scripts/main.gd"]);
    const godotCmd = godot?.checks.find((c) => c.id === "godot-check")?.command ?? [];
    expect(godotCmd).toEqual(expect.arrayContaining(["--check-only", "--script"]));
    const docs = await load("documentation");
    expect(docs?.checks.some((c) => c.when?.scriptExists !== undefined)).toBe(true);
  });

  it("qa-regression is an independent regression plan + evidence role usable by Sindri's qa role", async () => {
    const dir = join(HARNESSES, "qa-regression");
    const { manifest } = await validateHarnessDir(dir);
    expect(manifest?.compatibility.taskTypes).toEqual(expect.arrayContaining(["qa", "test"]));
    expect(manifest?.skills.required).toEqual(
      expect.arrayContaining(["regression-test-plan", "test-evidence"]),
    );
    const byId = new Map((manifest?.checks ?? []).map((c) => [c.id, c]));
    // Same definition as backend-node's `test` so the two compose without a conflict warning.
    const backend = (await validateHarnessDir(join(HARNESSES, "backend-node"))).manifest;
    expect(byId.get("test")).toEqual(backend?.checks.find((c) => c.id === "test"));
    expect(byId.get("e2e")?.when?.scriptExists).toEqual(["test:e2e"]);
    expect(byId.get("e2e")?.required).toBe(false);
    expect(existsSync(join(dir, "roles", "qa.yaml"))).toBe(true);
    const home = mkdtempSync(join(tmpdir(), "brokkr-home-"));
    const registry = new Registry({ cwd: home, builtinDir: HARNESSES, homeDir: home });
    await registry.load();
    const set = registry.resolve({
      harnesses: [
        { name: "qa-regression", range: "^1.0.0" },
        { name: "backend-node", range: "^1.0.0" },
        { name: "frontend-react", range: "^1.0.0" },
      ],
    });
    expect(registry.compose(set).warnings).toEqual([]);
  });

  describe("check contracts", () => {
    const NETWORK_CMDS = [/\baudit\b/, /\bnpm\s+(install|ci|publish)\b/, /\bcurl\b/, /\bwget\b/];

    it("no required check depends on the network unless policy allows it", async () => {
      for (const name of ALL) {
        const { manifest } = await validateHarnessDir(join(HARNESSES, name));
        for (const c of manifest?.checks ?? []) {
          if (!c.required || manifest?.policies.network === "allow") continue;
          expect(
            NETWORK_CMDS.some((re) => re.test(c.command.join(" "))),
            `${name}/${c.id} is required but needs network while policy is deny`,
          ).toBe(false);
        }
      }
    });

    it("dependency audits are advisory", async () => {
      const { manifest } = await validateHarnessDir(join(HARNESSES, "security-baseline"));
      const audits = manifest?.checks.filter((c) => c.id.startsWith("dependency-audit")) ?? [];
      expect(audits.length).toBe(2);
      expect(audits.every((c) => !c.required)).toBe(true);
    });

    it("only security-baseline references {{harnessDir}} in checks", async () => {
      for (const name of ALL) {
        const { manifest } = await validateHarnessDir(join(HARNESSES, name));
        const uses = (manifest?.checks ?? []).some((c) =>
          c.command.some((a) => a.includes("{{harnessDir}}")),
        );
        expect(uses, name).toBe(name === "security-baseline");
      }
    });

    it("backend-strict has no uninterpreted overrides", () => {
      const text = readFileSync(join(HARNESSES, "profiles", "backend-strict.yaml"), "utf8");
      expect(text).not.toContain("overrides");
    });
  });

  describe("profiles", () => {
    it("ships the three profiles", () => {
      const files = readdirSync(join(HARNESSES, "profiles")).sort();
      expect(files).toEqual(PROFILES.map((p) => `${p}.yaml`).sort());
    });

    it.each(PROFILES)("profile %s parses and resolves against the registry", async (name) => {
      const file = join(HARNESSES, "profiles", `${name}.yaml`);
      const parsed = parseManifestText(readFileSync(file, "utf8"), ProfileSchema, file);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.name).toBe(name);
      const home = mkdtempSync(join(tmpdir(), "brokkr-home-"));
      const registry = new Registry({ cwd: home, builtinDir: HARNESSES, homeDir: home });
      await registry.load();
      const set = registry.resolve({
        harnesses: parsed.value.harnesses.map((h) => ({ name: h.name, range: h.version })),
      });
      expect(set.harnesses.map((h) => h.manifest.metadata.name).sort()).toEqual(
        parsed.value.harnesses.map((h) => h.name).sort(),
      );
      expect(() => registry.compose(set)).not.toThrow();
    });

    it("profiles contain the specified harnesses", () => {
      const names = (p: string): string[] =>
        (
          parseManifestText(
            readFileSync(join(HARNESSES, "profiles", `${p}.yaml`), "utf8"),
            ProfileSchema,
            p,
          ) as { ok: true; value: { harnesses: Array<{ name: string }> } }
        ).value.harnesses.map((h) => h.name);
      expect(names("frontend-strict").sort()).toEqual(
        ["documentation", "frontend-react", "security-baseline"].sort(),
      );
      expect(names("backend-strict")).toEqual(
        expect.arrayContaining(["backend-node", "security-baseline"]),
      );
      expect(names("fullstack").sort()).toEqual(
        ["backend-node", "frontend-react", "security-baseline"].sort(),
      );
    });
  });

  it("harnesses/README.md indexes every harness and profile", () => {
    const readme = readFileSync(join(HARNESSES, "README.md"), "utf8");
    for (const n of [...ALL, ...PROFILES]) expect(readme).toContain(`\`${n}\``);
    expect(readme).toMatch(
      /\|\s*Name\s*\|\s*Version\s*\|\s*Task types\s*\|\s*Required skills\s*\|\s*Checks\s*\|/,
    );
  });
});

describe("security-baseline scanner", () => {
  const script = join(HARNESSES, "security-baseline/scripts/scan.mjs");
  const scan = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "brokkr-scan-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    const r = spawnSync("node", [script, "--kind", "all"], { cwd: dir, encoding: "utf8" });
    return {
      code: r.status,
      out: JSON.parse(r.stdout) as {
        findings: Array<{ confidence: string; rule: string; file: string; line: number }>;
      },
    };
  };

  it("tags confirmed secrets as finding and fails", () => {
    const r = scan({ "src/a.ts": 'const k = "AKIAIOSFODNN7EXAMPLE";\n' });
    expect(r.out.findings).toEqual([
      expect.objectContaining({ confidence: "finding", file: "src/a.ts", line: 1 }),
    ]);
    expect(r.code).toBe(1);
  });

  it("tags heuristics as heuristic and does not fail", () => {
    const r = scan({ "src/b.ts": "const x = eval(input);\n" });
    expect(r.out.findings.length).toBe(1);
    expect(r.out.findings[0]?.confidence).toBe("heuristic");
    expect(r.code).toBe(0);
  });

  it("is clean on benign files and never prints secret values", () => {
    const clean = scan({ "src/c.ts": "export const a = 1;\n" });
    expect(clean.out.findings).toEqual([]);
    expect(clean.code).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "brokkr-scan-"));
    writeFileSync(join(dir, "k.txt"), "AKIAIOSFODNN7EXAMPLE\n");
    const r = spawnSync("node", [script], { cwd: dir, encoding: "utf8" });
    expect(r.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
