import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "./temp-repo.js";

describe("createTempRepo", () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("writes nested files into a fresh temp directory", () => {
    repo = createTempRepo({ "README.md": "# Hi\n", "docs/a/b.md": "deep" });
    expect(readFileSync(join(repo.path, "README.md"), "utf8")).toBe("# Hi\n");
    expect(readFileSync(join(repo.path, "docs/a/b.md"), "utf8")).toBe("deep");
  });

  it("optionally initialises a local git repo", () => {
    repo = createTempRepo({ "a.txt": "x" }, { git: true });
    expect(existsSync(join(repo.path, ".git"))).toBe(true);
  });

  it("removes the directory on cleanup", () => {
    const r = createTempRepo({ "a.txt": "x" });
    r.cleanup();
    expect(existsSync(r.path)).toBe(false);
  });
});
