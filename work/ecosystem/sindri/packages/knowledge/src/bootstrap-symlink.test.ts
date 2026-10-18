import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";

const OUTSIDE_PHRASE = "outsidesecretphrase";

describe.each([
  { mode: "git repo", git: true },
  { mode: "plain directory", git: false },
])("bootstrapProject symlink containment ($mode)", ({ git }) => {
  let repo: TempRepo;
  let outside: string;
  let k: Knowledge;
  let projectId: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "sindri-outside-"));
    writeFileSync(join(outside, "notes.md"), `# Notes\n${OUTSIDE_PHRASE}\n`);
    writeFileSync(join(outside, "README.md"), `# Outside readme ${OUTSIDE_PHRASE}\n`);
    repo = createTempRepo(
      { "README.md": "# Inside\n", "docs/notes.md": "inside notes\n" },
      { git },
    );
    k = openKnowledge(":memory:");
    projectId = k.projects.create({ name: "demo", repoPath: repo.path }).id;
  });
  afterEach(() => {
    k.close();
    repo.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  const allText = () =>
    (k.db.prepare("SELECT text FROM chunks").all() as { text: string }[])
      .map((r) => r.text)
      .join("\n");
  const docPaths = () =>
    (k.db.prepare("SELECT path FROM documents").all() as { path: string }[]).map((r) => r.path);

  it("does not follow a symlinked parent directory of a listed path (reviewer case)", () => {
    if (git) execFileSync("git", ["add", "docs/notes.md"], { cwd: repo.path });
    rmSync(join(repo.path, "docs"), { recursive: true, force: true });
    symlinkSync(outside, join(repo.path, "docs"));
    const res = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(allText()).not.toContain(OUTSIDE_PHRASE);
    expect(docPaths()).not.toContain("docs/notes.md");
    const escaped = res.skipped.filter((s) => s.reason === "symlink_escape").map((s) => s.path);
    expect(escaped.some((p) => p === "docs" || p.startsWith("docs/"))).toBe(true);
    expect(k.search(projectId, OUTSIDE_PHRASE)).toEqual([]);
  });

  it("does not follow a file symlink", () => {
    rmSync(join(repo.path, "README.md"));
    symlinkSync(join(outside, "README.md"), join(repo.path, "README.md"));
    const res = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(allText()).not.toContain(OUTSIDE_PHRASE);
    expect(res.skipped).toContainEqual({ path: "README.md", reason: "symlink_escape" });
  });

  it("does not follow a directory symlink", () => {
    mkdirSync(join(repo.path, "docs", "sub"), { recursive: true });
    symlinkSync(outside, join(repo.path, "docs", "linked"));
    const res = k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(allText()).not.toContain(OUTSIDE_PHRASE);
    expect(res.skipped).toContainEqual({ path: "docs/linked", reason: "symlink_escape" });
    expect(docPaths()).toContain("docs/notes.md");
  });

  it("does not let a symlinked ignore file be read", () => {
    rmSync(join(repo.path, "README.md"));
    writeFileSync(join(outside, "ignore-src"), "docs/\n");
    symlinkSync(join(outside, "ignore-src"), join(repo.path, ".sindriignore"));
    k.bootstrapProject(projectId, { repoPath: repo.path });
    expect(docPaths()).toContain("docs/notes.md");
  });
});
