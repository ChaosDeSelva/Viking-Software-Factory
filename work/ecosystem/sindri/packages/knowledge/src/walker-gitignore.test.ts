import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { listCandidateFiles } from "./bootstrap.js";

// Review Ssec m1: the walker must apply nested .gitignore files the way git does (the deepest
// scope with a matching rule decides, so a nested `!pattern` re-includes).
describe("walker .gitignore semantics", () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("lets a nested negation re-include a file the root .gitignore excludes", () => {
    repo = createTempRepo({
      ".gitignore": "docs/*.md\n",
      "docs/.gitignore": "!keep.md\n",
      "docs/keep.md": "keep\n",
      "docs/drop.md": "drop\n",
    });
    const files = listCandidateFiles(repo.path);
    expect(files).toContain("docs/keep.md");
    expect(files).not.toContain("docs/drop.md");
  });

  it("lets a nested rule exclude what the root allows, and the root negate info/exclude", () => {
    repo = createTempRepo({
      ".gitignore": "!local.md\n",
      ".git/info/exclude": "local.md\nother.md\n",
      "local.md": "x\n",
      "other.md": "x\n",
      "docs/.gitignore": "secret-notes.md\n",
      "docs/secret-notes.md": "x\n",
    });
    const files = listCandidateFiles(repo.path);
    expect(files).toContain("local.md");
    expect(files).not.toContain("other.md");
    expect(files).not.toContain("docs/secret-notes.md");
  });

  it("cannot re-include a file inside an excluded directory (as in git)", () => {
    repo = createTempRepo({
      ".gitignore": "build/\n",
      "build/.gitignore": "!x.md\n",
      "build/x.md": "x\n",
    });
    expect(listCandidateFiles(repo.path)).not.toContain("build/x.md");
  });

  it(".sindriignore and default excludes always win", () => {
    repo = createTempRepo({
      ".sindriignore": "private/\n",
      "private/.gitignore": "!*\n",
      "private/a.md": "x\n",
      "node_modules/p/README.md": "x\n",
    });
    const files = listCandidateFiles(repo.path);
    expect(files).not.toContain("private/a.md");
    expect(files).not.toContain("node_modules/p/README.md");
  });
});
