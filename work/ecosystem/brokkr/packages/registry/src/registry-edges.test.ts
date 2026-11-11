import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokkrError } from "@brokkr/core";
import { Registry, inspectTarball, resolveHarnessSet } from "./index.js";
import { layout, tmp, writeHarness, type FixtureHarness } from "../test/helpers.js";
import { writeTarGz } from "../test/tar.js";

async function registryWith(harnesses: FixtureHarness[]) {
  const l = layout();
  for (const h of harnesses) writeHarness(l.builtin, h);
  const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
  await registry.load();
  return { registry, ...l };
}

function thrown(fn: () => unknown): BrokkrError {
  try {
    fn();
  } catch (error) {
    return error as BrokkrError;
  }
  throw new Error("expected a throw");
}

describe("Registry.load edges", () => {
  it("without a built-in directory only the user and project roots are sources", async () => {
    const l = layout();
    writeHarness(join(l.home, ".brokkr/harnesses"), { name: "u" });
    const registry = new Registry({ cwd: l.cwd, homeDir: l.home });
    await registry.load();
    expect(registry.sources().map((s) => s.kind)).toEqual(["user", "project"]);
    expect(registry.list().map((h) => h.manifest.metadata.name)).toEqual(["u"]);
  });

  it("projectSources: false never parses the repository's own config", async () => {
    const l = layout();
    mkdirSync(join(l.cwd, ".brokkr"));
    writeFileSync(join(l.cwd, ".brokkr/config.yaml"), "version: [not valid\n");
    const registry = new Registry({ cwd: l.cwd, homeDir: l.home, projectSources: false });
    await expect(registry.load()).resolves.toBeUndefined();
    expect(registry.diagnostics).toEqual([]);
  });

  it("lists several versions of one harness newest first, and every skill they ship", async () => {
    const { registry } = await registryWith([
      { name: "a", version: "1.0.0", required: ["s1"] },
      { name: "a", version: "2.0.0", required: ["s2"] },
    ]);
    expect(registry.list().map((h) => h.manifest.metadata.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(registry.skills().map((s) => s.manifest.metadata.name)).toEqual(["s2", "s1"]);
  });

  it("a missing path source is a source-error", async () => {
    const l = layout();
    const registry = new Registry({
      cwd: l.cwd,
      homeDir: l.home,
      config: {
        version: 1,
        harnesses: [],
        sources: [{ path: "vendor/h", digest: `sha256:${"0".repeat(64)}`, trusted: true }],
      },
    });
    await registry.load();
    expect(registry.diagnostics).toEqual([
      {
        code: "source-error",
        source: "external:vendor/h",
        message: `source path ${join(l.cwd, "vendor/h")} does not exist`,
      },
    ]);
  });

  it("a path source that cannot be hashed (it contains a symlink) is an integrity error", async () => {
    const l = layout();
    const dir = writeHarness(join(l.cwd, "vendor"), { name: "v" });
    symlinkSync("/etc/hosts", join(dir, "link"));
    const registry = new Registry({
      cwd: l.cwd,
      homeDir: l.home,
      config: {
        version: 1,
        harnesses: [],
        sources: [{ path: "vendor", digest: `sha256:${"0".repeat(64)}`, trusted: true }],
      },
    });
    await registry.load();
    expect(registry.list()).toEqual([]);
    expect(registry.diagnostics).toEqual([
      { code: "integrity", source: "external:vendor", message: expect.stringMatching(/symlink/) },
    ]);
  });
});

describe("lock creation and verification edges", () => {
  it("sorts harnesses, skills and adapters by name", async () => {
    const { registry } = await registryWith([
      { name: "b", required: ["zeta"] },
      { name: "a", required: ["alpha"] },
    ]);
    const set = registry.resolve({
      harnesses: [
        { name: "b", range: "*" },
        { name: "a", range: "*" },
      ],
    });
    const { lock } = await registry.writeLock(set, [
      { id: "codex", version: "1.0.0" },
      { id: "claude-code", version: "1.0.0" },
      { id: "codex", version: "1.0.0" },
    ]);
    expect(lock.harnesses.map((h) => h.name)).toEqual(["a", "b"]);
    expect(lock.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(lock.adapters.map((a) => a.id)).toEqual(["claude-code", "codex", "codex"]);
  });

  it("reports a locked skill whose directory was removed as missing", async () => {
    const { registry, builtin } = await registryWith([{ name: "a", required: ["s"] }]);
    const { lock } = await registry.writeLock(
      registry.resolve({ harnesses: [{ name: "a", range: "*" }] }),
      [],
    );
    rmSync(join(builtin, "a-1.0.0/skills/s"), { recursive: true });
    const verification = await registry.verifyLock(lock);
    expect(verification.ok).toBe(false);
    expect(verification.entries.map((e) => [e.kind, e.name, e.status])).toEqual([
      ["harness", "a", "modified"],
      ["skill", "s", "missing"],
    ]);
  });

  it("reports a harness that can no longer be hashed as modified, with the reason", async () => {
    const { registry, builtin } = await registryWith([{ name: "a" }]);
    const { lock } = await registry.writeLock(
      registry.resolve({ harnesses: [{ name: "a", range: "*" }] }),
      [],
    );
    symlinkSync("/etc/hosts", join(builtin, "a-1.0.0/planted"));
    const verification = await registry.verifyLock(lock);
    expect(verification.entries).toEqual([
      expect.objectContaining({
        kind: "harness",
        status: "modified",
        actual: expect.stringMatching(/^error:.*symlink/),
      }),
    ]);
  });
});

describe("resolveHarnessSet edges", () => {
  it("rejects an invalid version range", async () => {
    const { registry } = await registryWith([{ name: "a" }]);
    const error = thrown(() =>
      registry.resolve({ harnesses: [{ name: "a", range: "not-a-range" }] }),
    );
    expect(error.code).toBe("invalid-config");
    expect(error.message).toBe("invalid version range 'not-a-range' for harness 'a'");
  });

  it("reports a conflict that repeats between passes instead of looping", async () => {
    const { registry } = await registryWith([
      { name: "a", version: "1.0.0", dependsOn: [{ name: "b", version: "^2.0.0" }] },
      { name: "b", version: "2.0.0", dependsOn: [{ name: "a", version: "^2.0.0" }] },
    ]);
    const error = thrown(() => registry.resolve({ harnesses: [{ name: "a", range: "*" }] }));
    expect(error.code).toBe("version-conflict");
    expect(error.message).toBe(
      "no version of 'a' satisfies * (from request), ^2.0.0 (from b@2.0.0); available: 1.0.0",
    );
  });

  it("a declared conflict with a harness that is not selected does not block resolution", async () => {
    const { registry } = await registryWith([{ name: "a", conflictsWith: ["b"] }, { name: "b" }]);
    const set = registry.resolve({ harnesses: [{ name: "a", range: "*" }] });
    expect(set.harnesses.map((h) => h.manifest.metadata.name)).toEqual(["a"]);
  });

  it("rejects a dependency cycle", async () => {
    const { registry } = await registryWith([
      { name: "a", dependsOn: [{ name: "b", version: "*" }] },
      { name: "b", dependsOn: [{ name: "a", version: "*" }] },
    ]);
    const error = thrown(() => registry.resolve({ harnesses: [{ name: "a", range: "*" }] }));
    expect(error.code).toBe("version-conflict");
    expect(error.message).toBe("dependency cycle through harness 'a'");
  });

  it("checks platform and brokkr compatibility only when the caller supplies them", async () => {
    const { registry } = await registryWith([
      { name: "a", platforms: ["linux"], brokkr: ">=99.0.0" },
    ]);
    const set = resolveHarnessSet(registry.list(), { harnesses: [{ name: "a", range: "*" }] });
    expect(set.harnesses.map((h) => h.manifest.metadata.name)).toEqual(["a"]);
    expect(
      thrown(() =>
        resolveHarnessSet(
          registry.list(),
          { harnesses: [{ name: "a", range: "*" }] },
          { brokkrVersion: "1.0.0" },
        ),
      ).code,
    ).toBe("incompatible");
  });
});

describe("inspectTarball edges", () => {
  it("ignores a ./ member when finding the top-level directory", async () => {
    const file = join(tmp(), "dot.tgz");
    writeTarGz(file, [
      { name: "./", type: "5" },
      { name: "pkg/", type: "5" },
      { name: "pkg/harness.yaml", content: "x" },
    ]);
    expect(inspectTarball(file)).toEqual({
      entries: ["./", "pkg/", "pkg/harness.yaml"],
      topLevel: "pkg",
      problems: [],
    });
  });

  it("refuses a member name containing a newline", async () => {
    const file = join(tmp(), "nl.tgz");
    writeTarGz(file, [
      { name: "pkg/", type: "5" },
      { name: "pkg/a\nb", content: "x" },
    ]);
    const { problems } = inspectTarball(file);
    // bsdtar lists it escaped (`pkg/a\nb`), GNU tar raw (one listing line too many)
    expect(problems.join("\n")).toMatch(
      /is an absolute or non-POSIX path|archive listing is empty or ambiguous/,
    );
  });

  it("reports a missing tar binary as a problem rather than throwing", async () => {
    const file = join(tmp(), "h.tgz");
    writeTarGz(file, [{ name: "pkg/harness.yaml", content: "x" }]);
    const path = process.env.PATH;
    process.env.PATH = tmp();
    try {
      const inspection = inspectTarball(file);
      expect(inspection.entries).toEqual([]);
      expect(inspection.problems).toEqual([
        expect.stringMatching(/^cannot list archive: .*ENOENT/),
      ]);
    } finally {
      process.env.PATH = path;
    }
  });
});
