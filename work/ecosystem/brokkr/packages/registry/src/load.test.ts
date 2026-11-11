import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { Registry, discoverHarnessDirs, validateHarnessDir } from "./index.js";
import { harnessManifest, layout, skillManifest, tmp, writeHarness } from "../test/helpers.js";

describe("validateHarnessDir never throws on a malformed package layout", () => {
  it("reports a harness.yaml that is a directory instead of failing the whole registry load", async () => {
    const l = layout();
    writeHarness(l.builtin, { name: "good" });
    mkdirSync(join(l.builtin, "broken/harness.yaml"), { recursive: true });
    const result = await validateHarnessDir(join(l.builtin, "broken"));
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/EISDIR/);

    const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
    await registry.load();
    expect(registry.list().map((h) => h.manifest.metadata.name)).toEqual(["good"]);
    expect(registry.diagnostics).toEqual([
      {
        code: "invalid",
        source: join(l.builtin, "broken"),
        message: expect.stringMatching(/EISDIR/),
      },
    ]);
  });

  it("reports a skills entry that is a regular file", async () => {
    const dir = writeHarness(tmp(), { name: "a" });
    rmSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills"), "not a directory\n");
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.message).join("\n")).toMatch(/ENOTDIR/);
  });
});

describe("validateHarnessDir skill checks", () => {
  it("reports a skill directory without a manifest and an invalid skill manifest, each with its file", async () => {
    const dir = writeHarness(tmp(), { name: "a", required: ["ok"] });
    mkdirSync(join(dir, "skills/empty"));
    mkdirSync(join(dir, "skills/bad"));
    writeFileSync(join(dir, "skills/bad/skill.yaml"), "kind: Skill\n");
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      path: "",
      file: "skills/empty/skill.yaml",
      message: "skill manifest missing",
    });
    expect(result.issues.filter((i) => i.file === "skills/bad/skill.yaml").length).toBeGreaterThan(
      0,
    );
  });

  it("names the actual manifest file when a JSON skill manifest has an unshipped dependency", async () => {
    const dir = writeHarness(tmp(), { name: "a", required: ["s"] });
    rmSync(join(dir, "skills/s/skill.yaml"));
    writeFileSync(
      join(dir, "skills/s/skill.json"),
      JSON.stringify(skillManifest({ name: "s", dependsOn: ["ghost"] })),
    );
    const result = await validateHarnessDir(dir);
    expect(result.issues).toEqual([
      {
        path: "dependsOn.0",
        file: "skills/s/skill.json",
        message: "skill dependency 'ghost' is not shipped by this harness package",
      },
    ]);
  });

  it("warns about a shipped skill nobody references, but not about one another skill depends on", async () => {
    const dir = writeHarness(tmp(), {
      name: "a",
      required: ["main"],
      skills: [{ name: "main", dependsOn: ["helper"] }, { name: "helper" }, { name: "orphan" }],
    });
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([
      "skill 'orphan' is shipped but not referenced by the harness",
    ]);
    expect(result.pkg?.skills.map((s) => s.manifest.metadata.name)).toEqual([
      "helper",
      "main",
      "orphan",
    ]);
    expect(result.pkg?.skills.every((s) => /^sha256:[0-9a-f]{64}$/.test(s.digest))).toBe(true);
  });

  it("accepts harness.json and harness.yml manifests", async () => {
    for (const [file, text] of [
      ["harness.json", JSON.stringify(harnessManifest({ name: "a" }))],
      ["harness.yml", stringify(harnessManifest({ name: "a" }))],
    ] as const) {
      const dir = writeHarness(tmp(), { name: "a" });
      rmSync(join(dir, "harness.yaml"));
      writeFileSync(join(dir, file), text);
      const result = await validateHarnessDir(dir);
      expect(result.valid).toBe(true);
      expect(result.manifest?.metadata.name).toBe("a");
    }
  });
});

describe("validateHarnessDir on manifests that fail to parse", () => {
  it("still reports unshipped skills listed in a schema-invalid JSON manifest", async () => {
    const dir = join(tmp(), "pkg");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "harness.json"),
      JSON.stringify({ kind: "Harness", skills: { required: ["ghost"], optional: [7] } }),
    );
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.issues).toContainEqual({
      path: "skills.required.0",
      file: "harness.json",
      message: "skill 'ghost' is not shipped in skills/ghost/",
    });
    expect(result.issues.some((i) => i.path.startsWith("skills.optional"))).toBe(true);
  });

  it.each([
    ["syntactically broken YAML", "harness.yaml", "metadata: [unclosed\n"],
    ["syntactically broken JSON", "harness.json", "{ nope"],
    ["an empty manifest", "harness.yaml", ""],
    ["a scalar skills field", "harness.yaml", "skills: none\n"],
  ])("reports %s as invalid without a second error", async (_label, file, text) => {
    const dir = join(tmp(), "pkg");
    mkdirSync(dir);
    writeFileSync(join(dir, file), text);
    const result = await validateHarnessDir(dir);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((i) => !/not shipped/.test(i.message))).toBe(true);
  });
});

describe("discoverHarnessDirs", () => {
  it("finds the root itself, children and grandchildren, in sorted order", async () => {
    const root = tmp();
    expect(await discoverHarnessDirs(join(root, "missing"))).toEqual([]);
    const b = writeHarness(join(root, "group"), { name: "b" }, "b");
    const a = writeHarness(root, { name: "a" }, "a");
    mkdirSync(join(root, "empty/also-empty"), { recursive: true });
    writeFileSync(join(root, "README.md"), "not a harness\n");
    expect(await discoverHarnessDirs(root)).toEqual([a, b]);
    expect(await discoverHarnessDirs(a)).toEqual([a]);
  });

  it("does not descend into a harness, hidden directories, or deeper than grandchildren", async () => {
    const root = tmp();
    const a = writeHarness(root, { name: "a" }, "a");
    writeHarness(a, { name: "nested" }, "nested");
    writeHarness(join(root, ".hidden"), { name: "hidden" }, "hidden");
    writeHarness(join(root, "x/.hidden"), { name: "hidden2" }, "hidden2");
    writeHarness(join(root, "x/y/z"), { name: "deep" }, "deep");
    expect(await discoverHarnessDirs(root)).toEqual([a]);
  });

  it("never follows a symlinked harness directory out of the source root", async () => {
    const l = layout();
    const elsewhere = writeHarness(tmp(), { name: "elsewhere" }, "elsewhere");
    const harnesses = join(l.cwd, ".brokkr/harnesses");
    mkdirSync(join(harnesses, "group"), { recursive: true });
    symlinkSync(elsewhere, join(harnesses, "linked"));
    symlinkSync(elsewhere, join(harnesses, "group/linked"));
    expect(await discoverHarnessDirs(harnesses)).toEqual([]);
    const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
    await registry.load();
    expect(registry.list()).toEqual([]);
  });

  it("a harness whose skill directory was replaced by a symlink is invalid, not loaded", async () => {
    const l = layout();
    const dir = writeHarness(l.builtin, { name: "a", required: ["s"] });
    const moved = join(tmp(), "s");
    renameSync(join(dir, "skills/s"), moved);
    symlinkSync(moved, join(dir, "skills/s"));
    const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
    await registry.load();
    expect(registry.list()).toEqual([]);
    expect(registry.diagnostics[0]?.code).toBe("invalid");
    expect(registry.diagnostics[0]?.message).toMatch(/not shipped in skills\/s\/.*symlink/);
  });
});
