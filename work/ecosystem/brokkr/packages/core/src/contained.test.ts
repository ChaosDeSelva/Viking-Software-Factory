import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkContainedFile, readContainedFile } from "./index.js";

function setup(): { base: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "brokkr-contained-"));
  const outside = mkdtempSync(join(tmpdir(), "brokkr-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  writeFileSync(join(base, "body.md"), "# ok\n");
  return { base, outside };
}

describe("contained file checks", () => {
  it("accepts a regular file inside the base", async () => {
    const { base } = setup();
    expect(checkContainedFile(base, "body.md")).toBeUndefined();
    expect(await readContainedFile(base, "body.md")).toBe("# ok\n");
  });

  it("rejects a symlinked file pointing outside", async () => {
    const { base, outside } = setup();
    symlinkSync(join(outside, "secret.txt"), join(base, "link.md"));
    expect(checkContainedFile(base, "link.md")).toMatch(/symlink/);
    await expect(readContainedFile(base, "link.md")).rejects.toThrow(/symlink/);
  });

  it("rejects a path through a symlinked directory", () => {
    const { base, outside } = setup();
    symlinkSync(outside, join(base, "node_modules"));
    expect(checkContainedFile(base, "node_modules/secret.txt")).toMatch(/outside|symlink/);
  });

  it("rejects traversal, missing files and directories", () => {
    const { base } = setup();
    mkdirSync(join(base, "dir"));
    expect(checkContainedFile(base, "../x")).toMatch(/outside/);
    expect(checkContainedFile(base, "missing.md")).toMatch(/does not exist/);
    expect(checkContainedFile(base, "dir")).toMatch(/regular file/);
  });
});
