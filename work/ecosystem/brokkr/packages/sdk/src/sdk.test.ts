import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { treeDigest } from "@brokkr/core";
import { describe, expect, it } from "vitest";
import { Brokkr, type Selection } from "./index.js";
import { BUILTIN, TASK, copyHarness, reactRepo, tempDir, writeConfig } from "../test/fixtures.js";

const sdk = (cwd: string, extra: Record<string, unknown> = {}) =>
  new Brokkr({ cwd, builtinDir: BUILTIN, homeDir: tempDir("brokkr-home-"), ...extra });

const names = (s: Selection) => s.harnesses.map((h) => h.name).sort();

describe("Brokkr.resolve", () => {
  it("resolves a built-in profile into harnesses, skills, lock and rationale", async () => {
    const cwd = reactRepo();
    const selection = await sdk(cwd).resolve({ task: TASK, profile: "frontend-strict" });
    expect(selection.schemaVersion).toBe(1);
    expect(selection.profile).toBe("frontend-strict");
    expect(names(selection)).toEqual(["documentation", "frontend-react", "security-baseline"]);
    const react = selection.harnesses.find((h) => h.name === "frontend-react");
    expect(react?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(react?.checks).toContainEqual({ id: "typecheck", required: true });
    expect(react?.trust).toBe("trusted");
    expect(react?.executionAllowed).toBe(true);
    expect(selection.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["react-architecture", "accessibility", "secret-scan"]),
    );
    for (const s of selection.skills) expect(s.digest).toMatch(/^sha256:/);
    expect(selection.lock.lockVersion).toBe(2);
    expect(selection.lock.harnesses.map((h) => h.name).sort()).toEqual(names(selection));
    expect(selection.rationale).toContainEqual(
      expect.objectContaining({ kind: "harness", name: "frontend-react", selected: true }),
    );
    expect(selection.rationale.some((r) => r.kind === "skill")).toBe(true);
  });

  it("is deterministic: the same input yields the same lock digest", async () => {
    const cwd = reactRepo();
    const a = await sdk(cwd).resolve({ task: TASK, profile: "fullstack" });
    const b = await sdk(cwd).resolve({ task: TASK, profile: "fullstack" });
    expect(a.lock.digest).toBe(b.lock.digest);
    expect(a.skills).toEqual(b.skills);
  });

  it("resolves explicit harness requests", async () => {
    const cwd = reactRepo();
    const s = await sdk(cwd).resolve({
      task: TASK,
      harnesses: [{ name: "backend-node", version: "^1.0.0" }],
    });
    expect(names(s)).toEqual(["backend-node"]);
    expect(s.rationale).toContainEqual(
      expect.objectContaining({ kind: "harness", name: "backend-node", reason: "requested" }),
    );
  });

  it("developer mode: uses .brokkr/config.yaml harnesses when neither profile nor harnesses is given", async () => {
    const cwd = reactRepo();
    writeConfig(cwd, "version: 1\nharnesses:\n  - name: documentation\n    version: ^1.0.0\n");
    const s = await sdk(cwd, { trust: "developer" }).resolve({ task: TASK });
    expect(names(s)).toEqual(["documentation"]);
  });

  it("chooses by task types, then repository signals, when nothing is configured", async () => {
    const cwd = reactRepo();
    const qa = await sdk(cwd).resolve({
      task: { ...TASK, id: "QA-1", tags: [], taskTypes: ["qa"] },
    });
    expect(names(qa)).toEqual(["qa-regression"]);
    expect(qa.rationale).toContainEqual(
      expect.objectContaining({ kind: "harness", name: "frontend-react", selected: false }),
    );
    const bySignals = await sdk(cwd).resolve({ task: TASK });
    expect(names(bySignals)).toEqual(["frontend-react"]);
  });

  it("fails with not-found when nothing matches", async () => {
    const cwd = tempDir();
    await expect(sdk(cwd).resolve({ task: { ...TASK, tags: [] } })).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(
      sdk(cwd).resolve({ task: TASK, profile: "no-such-profile" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("rejects invalid input", async () => {
    const cwd = reactRepo();
    await expect(
      sdk(cwd).resolve({
        task: TASK,
        profile: "fullstack",
        harnesses: [{ name: "backend-node", version: "^1.0.0" }],
      } as never),
    ).rejects.toMatchObject({ code: "invalid-config" });
    await expect(sdk(cwd).resolve({ task: { ...TASK, id: "../etc" } })).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("writes nothing into the repository", async () => {
    const cwd = reactRepo();
    await sdk(cwd).resolve({ task: TASK, profile: "frontend-strict" });
    expect(existsSync(join(cwd, ".brokkr"))).toBe(false);
  });

  it("refuses an untrusted source", async () => {
    const cwd = reactRepo();
    const dir = copyHarness("documentation", join(cwd, "vendor"));
    const manifest = join(dir, "harness.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("name: documentation", "name: vendor-docs"),
    );
    const digest = await treeDigest(join(cwd, "vendor"));
    writeConfig(
      cwd,
      `version: 1\nharnesses: []\nsources:\n  - path: vendor\n    digest: "${digest}"\n    trusted: false\n`,
    );
    const dev = { trust: "developer" };
    await expect(
      sdk(cwd, dev).resolve({
        task: TASK,
        harnesses: [{ name: "vendor-docs", version: "^1.0.0" }],
      }),
    ).rejects.toMatchObject({ code: "trust_required" });
    expect((await sdk(cwd, dev).listHarnesses()).find((h) => h.name === "vendor-docs")?.trust).toBe(
      "untrusted",
    );
    // A selection forged to name the untrusted harness is refused before anything is written.
    const real = await sdk(cwd, dev).resolve({
      task: TASK,
      harnesses: [{ name: "documentation", version: "^1.0.0" }],
    });
    const forged: Selection = {
      ...real,
      harnesses: real.harnesses.map((h) => ({ ...h, name: "vendor-docs", trust: "trusted" })),
    };
    await expect(
      sdk(cwd, dev).prepare({ selection: forged, provider: "claude-code" }),
    ).rejects.toMatchObject({ code: "trust_required" });
    expect(existsSync(join(cwd, ".brokkr", "generated"))).toBe(false);
  });
});

describe("Brokkr.prepare", () => {
  it("writes a provider bundle from a JSON round-tripped selection", async () => {
    const cwd = reactRepo();
    const brokkr = sdk(cwd);
    const selection = JSON.parse(
      JSON.stringify(await brokkr.resolve({ task: TASK, profile: "frontend-strict" })),
    ) as Selection;
    const prepared = await brokkr.prepare({ selection, provider: "claude-code" });
    expect(prepared.adapterId).toBe("claude-code");
    expect(existsSync(prepared.entrypoint)).toBe(true);
    expect(prepared.files.some((f) => f.relativePath.endsWith("SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    await brokkr.cleanup({ selection, provider: "claude-code" });
    expect(existsSync(prepared.entrypoint)).toBe(false);
  });

  it("supports codex and generic and rejects unknown providers", async () => {
    const cwd = reactRepo();
    const brokkr = sdk(cwd);
    const selection = await brokkr.resolve({ task: TASK, profile: "frontend-strict" });
    expect((await brokkr.prepare({ selection, provider: "codex" })).adapterId).toBe("codex");
    expect((await brokkr.prepare({ selection, provider: "generic" })).adapterId).toBe("generic");
    await expect(brokkr.prepare({ selection, provider: "nope" as never })).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("refuses a selection whose harness digest no longer matches", async () => {
    const cwd = reactRepo();
    const brokkr = sdk(cwd);
    const selection = await brokkr.resolve({ task: TASK, profile: "frontend-strict" });
    const forged: Selection = {
      ...selection,
      harnesses: selection.harnesses.map((h) => ({ ...h, digest: `sha256:${"0".repeat(64)}` })),
    };
    await expect(
      brokkr.prepare({ selection: forged, provider: "claude-code" }),
    ).rejects.toMatchObject({ code: "integrity" });
    expect(existsSync(join(cwd, ".brokkr", "generated"))).toBe(false);
  });

  it("refuses a selection that names a skill the harnesses do not ship", async () => {
    const cwd = reactRepo();
    const brokkr = sdk(cwd);
    const selection = await brokkr.resolve({ task: TASK, profile: "frontend-strict" });
    const forged: Selection = {
      ...selection,
      skills: [...selection.skills, { ...selection.skills[0]!, name: "exfiltrate" }],
    };
    await expect(
      brokkr.prepare({ selection: forged, provider: "claude-code" }),
    ).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("Brokkr.listHarnesses / inspectRepo", () => {
  it("lists the built-in library with skills and checks", async () => {
    const list = await sdk(tempDir()).listHarnesses();
    const qa = list.find((h) => h.name === "qa-regression");
    expect(qa).toMatchObject({
      version: "1.0.0",
      source: "builtin",
      trust: "trusted",
      taskTypes: expect.arrayContaining(["qa"]),
    });
    expect(qa?.skills.required).toContain("regression-test-plan");
    expect(qa?.checks).toContainEqual({ id: "test", required: true });
    expect(list.map((h) => h.name)).toEqual([...list.map((h) => h.name)].sort());
  });

  it("inspects repository signals read-only", async () => {
    const cwd = reactRepo();
    const signals = await sdk(cwd).inspectRepo();
    expect(signals.packageManager).toBe("pnpm");
    expect(signals.frameworks).toContain("react");
    expect(signals.scripts).toContain("test");
    expect(existsSync(join(cwd, ".brokkr"))).toBe(false);
  });
});
