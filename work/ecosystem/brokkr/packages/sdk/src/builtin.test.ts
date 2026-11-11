import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultBuiltinDir } from "./builtin.js";
import { BUILTIN, tempDir } from "../test/fixtures.js";

describe("defaultBuiltinDir", () => {
  it("prefers the library shipped next to dist/ in an installed package", () => {
    const pkg = join(tempDir("brokkr-pkg-"), "node_modules", "@brokkr", "sdk");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "harnesses"));
    expect(defaultBuiltinDir(pathToFileURL(join(pkg, "dist", "brokkr.js")).href)).toBe(
      join(pkg, "harnesses"),
    );
  });

  it("falls back to the repository library three levels up", () => {
    const repo = tempDir("brokkr-repo-");
    const dist = join(repo, "packages", "sdk", "dist");
    mkdirSync(dist, { recursive: true });
    expect(defaultBuiltinDir(pathToFileURL(join(dist, "brokkr.js")).href)).toBe(
      join(repo, "harnesses"),
    );
  });

  it("resolves to this repository's harnesses when run from source", () => {
    expect(defaultBuiltinDir()).toBe(BUILTIN);
  });
});
