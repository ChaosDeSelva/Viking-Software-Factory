import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSafeDir } from "./index.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "brokkr-statedir-"));

describe("ensureSafeDir (audit I6)", () => {
  it("creates nested state directories inside the base", async () => {
    const base = tmp();
    const dir = await ensureSafeDir(base, ".brokkr/cache/sources");
    expect(dir).toBe(join(base, ".brokkr", "cache", "sources"));
    expect(existsSync(dir)).toBe(true);
    expect(await ensureSafeDir(base, ".brokkr/cache/sources")).toBe(dir);
  });

  it("refuses a symlink at any component and leaves its target untouched", async () => {
    for (const linkAt of [".brokkr", ".brokkr/cache"]) {
      const base = tmp();
      const outside = tmp();
      if (linkAt === ".brokkr/cache") mkdirSync(join(base, ".brokkr"));
      symlinkSync(outside, join(base, linkAt));
      await expect(ensureSafeDir(base, ".brokkr/cache/sources"), linkAt).rejects.toMatchObject({
        code: "policy-denied",
      });
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it("refuses a component that is a file, and paths that escape the base", async () => {
    const base = tmp();
    writeFileSync(join(base, ".brokkr"), "x");
    await expect(ensureSafeDir(base, ".brokkr/runs")).rejects.toMatchObject({
      code: "invalid-config",
    });
    await expect(ensureSafeDir(tmp(), "../x")).rejects.toMatchObject({ code: "policy-denied" });
  });
});

describe("ensureSafeDir with a base that does not exist yet", () => {
  it("creates the base (e.g. a fresh BROKKR_HOME) and then the state directory", async () => {
    const base = join(tmp(), "fresh-home");
    const dir = await ensureSafeDir(base, ".brokkr/runs");
    expect(existsSync(dir)).toBe(true);
  });
});
