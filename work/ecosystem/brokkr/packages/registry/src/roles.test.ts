import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RoleSchema, TEMPLATE_PLACEHOLDERS, validateWith } from "@brokkr/core";
import { templatePlaceholderIssues, validateHarnessDir } from "./index.js";
import { tmp, writeHarness } from "../test/helpers.js";

const BUILTIN = resolve(import.meta.dirname, "../../../harnesses");

describe("RoleSchema", () => {
  const role = {
    name: "implementer",
    agentKind: "coding-agent",
    model: "any",
    skills: ["typescript"],
    responsibilities: ["Write a failing test first"],
  };

  it("accepts name, agentKind, optional model, skills and responsibilities", () => {
    expect(validateWith(RoleSchema, role).ok).toBe(true);
    const noModel: Record<string, unknown> = { ...role };
    delete noModel.model;
    expect(validateWith(RoleSchema, noModel).ok).toBe(true);
  });

  it("rejects unknown keys and empty responsibilities", () => {
    expect(validateWith(RoleSchema, { ...role, shell: "rm -rf /" }).ok).toBe(false);
    expect(validateWith(RoleSchema, { ...role, responsibilities: [] }).ok).toBe(false);
    expect(validateWith(RoleSchema, { ...role, name: "Not Kebab" }).ok).toBe(false);
  });
});

describe("templatePlaceholderIssues", () => {
  it("allows only the brief placeholders", () => {
    expect(TEMPLATE_PLACEHOLDERS).toEqual([
      "objective",
      "acceptanceCriteria",
      "context",
      "constraints",
    ]);
    expect(
      templatePlaceholderIssues(
        "# {{objective}}\n{{acceptanceCriteria}} {{context}} {{ constraints }}",
      ),
    ).toEqual([]);
    expect(templatePlaceholderIssues("{{objective}} {{secrets}} {{env.HOME}}")).toEqual([
      "unknown placeholder {{secrets}}",
      "unknown placeholder {{env.HOME}}",
    ]);
  });

  it("tolerates {{harnessDir}} inside inline code (documented check commands)", () => {
    expect(templatePlaceholderIssues("- `node {{harnessDir}}/scripts/scan.mjs`")).toEqual([]);
    expect(templatePlaceholderIssues("run {{harnessDir}}/x")).toEqual([
      "unknown placeholder {{harnessDir}}",
    ]);
  });
});

describe("validateHarnessDir covers roles and templates", () => {
  function pkg(): string {
    return writeHarness(tmp(), { name: "demo", required: ["typescript"] });
  }

  it("accepts valid roles and a valid brief template", async () => {
    const dir = pkg();
    mkdirSync(join(dir, "roles"));
    writeFileSync(
      join(dir, "roles", "implementer.yaml"),
      "name: implementer\nagentKind: coding-agent\nskills: [typescript]\nresponsibilities: [Test first]\n",
    );
    mkdirSync(join(dir, "templates"));
    writeFileSync(join(dir, "templates", "brief.md"), "# {{objective}}\n{{constraints}}\n");
    const result = await validateHarnessDir(dir);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("reports invalid role files and roles referencing skills the harness does not ship", async () => {
    const dir = pkg();
    mkdirSync(join(dir, "roles"));
    writeFileSync(join(dir, "roles", "bad.yaml"), "name: bad\nresponsibilities: []\nextra: 1\n");
    writeFileSync(
      join(dir, "roles", "reviewer.yaml"),
      "name: reviewer\nskills: [typescript, nonexistent]\nresponsibilities: [Review]\n",
    );
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    const text = result.issues.map((i) => `${i.file}:${i.path}: ${i.message}`).join("\n");
    expect(text).toMatch(/roles\/bad.yaml/);
    expect(text).toMatch(/roles\/reviewer.yaml:skills.1: .*nonexistent.*not shipped/);
  });

  it("reports unknown template placeholders", async () => {
    const dir = pkg();
    mkdirSync(join(dir, "templates"));
    writeFileSync(join(dir, "templates", "brief.md"), "{{objective}} {{apiKey}}\n");
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        file: "templates/brief.md",
        message: "unknown placeholder {{apiKey}}",
      }),
    );
  });

  it("every built-in harness passes role and template validation", async () => {
    for (const name of readdirSync(BUILTIN, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "profiles")
      .map((e) => e.name)) {
      const result = await validateHarnessDir(join(BUILTIN, name));
      expect(result.issues, name).toEqual([]);
    }
  });
});

describe("project-local harness trust (audit C1)", () => {
  it("projectHarnessTrust: untrusted makes workspace harnesses non-executable", async () => {
    const { Registry } = await import("./index.js");
    const { mkdirSync } = await import("node:fs");
    const cwd = tmp();
    mkdirSync(join(cwd, ".brokkr", "harnesses"), { recursive: true });
    writeHarness(join(cwd, ".brokkr", "harnesses"), { name: "noop", required: ["typescript"] });
    const config = { version: 1 as const, harnesses: [{ name: "noop", version: "^1.0.0" }] };
    const untrusted = new Registry({
      cwd,
      builtinDir: join(cwd, "none"),
      homeDir: tmp(),
      config,
      projectHarnessTrust: "untrusted",
    });
    await untrusted.load();
    expect(untrusted.inspect("noop")?.trust).toBe("untrusted");
    expect(
      untrusted.resolve({ harnesses: [{ name: "noop", range: "^1.0.0" }], allowUntrusted: true })
        .harnesses[0]?.executionAllowed,
    ).toBe(false);
    const trusted = new Registry({ cwd, builtinDir: join(cwd, "none"), homeDir: tmp(), config });
    await trusted.load();
    expect(trusted.inspect("noop")?.trust).toBe("trusted");
  });
});
