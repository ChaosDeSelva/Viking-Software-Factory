import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  LOCK_FILE,
  Registry,
  ensureBrokkrDir,
  loadProjectConfig,
  readLock,
  saveProjectConfig,
} from "./index.js";
import { layout, tmp, writeHarness } from "../test/helpers.js";

describe("ensureBrokkrDir", () => {
  it("creates .brokkr when missing and accepts an existing directory", async () => {
    const cwd = tmp();
    expect(await ensureBrokkrDir(cwd)).toBe(join(cwd, ".brokkr"));
    writeFileSync(join(cwd, ".brokkr/keep.txt"), "kept\n");
    expect(await ensureBrokkrDir(cwd)).toBe(join(cwd, ".brokkr"));
    expect(readFileSync(join(cwd, ".brokkr/keep.txt"), "utf8")).toBe("kept\n");
  });

  it("refuses a .brokkr that is a regular file", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".brokkr"), "not a directory\n");
    await expect(ensureBrokkrDir(cwd)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/not a directory/),
    });
    expect(readFileSync(join(cwd, ".brokkr"), "utf8")).toBe("not a directory\n");
  });
});

describe("project config file", () => {
  it("round-trips through save and load, and is absent until saved", async () => {
    const cwd = tmp();
    expect(await loadProjectConfig(cwd)).toBeUndefined();
    const config = {
      version: 1 as const,
      project: "demo",
      harnesses: [{ name: "alpha", version: "^1.0.0" }],
    };
    const file = await saveProjectConfig(cwd, config);
    expect(file).toBe(join(cwd, CONFIG_FILE));
    expect(parse(readFileSync(file, "utf8"))).toEqual(config);
    expect(await loadProjectConfig(cwd)).toEqual(config);
  });

  it("rejects a malformed config file with the offending path", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".brokkr"));
    writeFileSync(join(cwd, CONFIG_FILE), "version: 1\nharnesses:\n  - name: Not_Kebab\n");
    await expect(loadProjectConfig(cwd)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/invalid \.brokkr\/config\.yaml:[\s\S]*harnesses\.0/),
    });
  });

  it("refuses to save an invalid config and writes nothing", async () => {
    const cwd = tmp();
    await expect(
      saveProjectConfig(cwd, {
        version: 1,
        harnesses: [{ name: "alpha", version: "not a range" }],
      }),
    ).rejects.toMatchObject({ code: "invalid-config" });
    expect(await loadProjectConfig(cwd)).toBeUndefined();
  });

  it("refuses to write the config through a symlinked config.yaml", async () => {
    const cwd = tmp();
    const outside = join(tmp("brokkr-target-"), "victim.txt");
    writeFileSync(outside, "precious\n");
    mkdirSync(join(cwd, ".brokkr"));
    symlinkSync(outside, join(cwd, CONFIG_FILE));
    await expect(saveProjectConfig(cwd, { version: 1, harnesses: [] })).rejects.toMatchObject({
      code: "policy-denied",
    });
    expect(readFileSync(outside, "utf8")).toBe("precious\n");
  });
});

describe("lock file", () => {
  it("is absent until written", async () => {
    expect(await readLock(tmp())).toBeUndefined();
  });

  it("rejects a lock file that is not valid JSON or does not match the schema", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".brokkr"));
    writeFileSync(join(cwd, LOCK_FILE), "{ not json");
    await expect(readLock(cwd)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/invalid \.brokkr\/harness\.lock\.json/),
    });
    writeFileSync(join(cwd, LOCK_FILE), JSON.stringify({ lockVersion: 2, harnesses: [] }));
    await expect(readLock(cwd)).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/digest/),
    });
  });

  it("refuses to write the lock through a symlinked harness.lock.json", async () => {
    const l = layout();
    writeHarness(l.builtin, { name: "a" });
    const outside = join(tmp("brokkr-target-"), "victim.txt");
    writeFileSync(outside, "precious\n");
    mkdirSync(join(l.cwd, ".brokkr"));
    symlinkSync(outside, join(l.cwd, LOCK_FILE));
    const registry = new Registry({ cwd: l.cwd, builtinDir: l.builtin, homeDir: l.home });
    await registry.load();
    const set = registry.resolve({ harnesses: [{ name: "a", range: "*" }] });
    await expect(registry.writeLock(set, [])).rejects.toMatchObject({ code: "policy-denied" });
    expect(readFileSync(outside, "utf8")).toBe("precious\n");
  });
});
