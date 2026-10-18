import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultBuiltinDir } from "./paths.js";

describe("defaultBuiltinDir", () => {
  it("prefers BROKKR_BUILTIN_HARNESSES", () => {
    expect(defaultBuiltinDir({ BROKKR_BUILTIN_HARNESSES: "/x/h" })).toBe("/x/h");
  });

  it("finds the library shipped inside an installed package (<pkg>/harnesses)", () => {
    const root = mkdtempSync(join(tmpdir(), "brokkr-paths-"));
    const pkg = join(root, "node_modules", "@brokkr", "cli");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "harnesses"));
    const base = pathToFileURL(join(pkg, "dist", "bin.js")).href;
    expect(defaultBuiltinDir({}, base)).toBe(join(pkg, "harnesses"));
  });

  it("falls back to the source repository layout (<repo>/harnesses)", () => {
    const root = mkdtempSync(join(tmpdir(), "brokkr-paths-"));
    mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
    mkdirSync(join(root, "harnesses"));
    const base = pathToFileURL(join(root, "apps", "cli", "dist", "bin.js")).href;
    expect(defaultBuiltinDir({}, base)).toBe(join(root, "harnesses"));
  });
});
