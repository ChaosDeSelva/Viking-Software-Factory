import { execFileSync } from "node:child_process";
import { createTempRepo, type TempRepo } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitRepoReader } from "./repo-reader.js";

describe("gitRepoReader", () => {
  let repo: TempRepo;
  let head: string;
  beforeEach(() => {
    repo = createTempRepo({ "src/a.ts": "one\ntwo\nthree\n", "empty.txt": "" }, { git: true });
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        {
          cwd: repo.path,
        },
      )
        .toString()
        .trim();
    git("add", "-A");
    git("commit", "-qm", "init");
    head = git("rev-parse", "HEAD");
  });
  afterEach(() => repo.cleanup());

  const reader = () => gitRepoReader((id) => (id === "p" ? repo.path : undefined));

  it("counts the lines of a file at a commit", async () => {
    expect(await reader().lineCount("p", head, "src/a.ts")).toBe(3);
    expect(await reader().lineCount("p", head, "empty.txt")).toBe(0);
  });

  it("answers null only for a path missing at a commit that resolves", async () => {
    expect(await reader().lineCount("p", head, "src/missing.ts")).toBeNull();
    expect(await reader().lineCount("p", head, "src")).toBeNull();
  });

  it("names why a file could not be checked", async () => {
    await expect(reader().lineCount("p", "f".repeat(40), "src/a.ts")).rejects.toThrow(
      "commit_unresolvable",
    );
    await expect(reader().lineCount("other", head, "src/a.ts")).rejects.toThrow("repo_unavailable");
    await expect(reader().lineCount("p", "not-a-sha", "src/a.ts")).rejects.toThrow(
      "commit_invalid",
    );
  });
});
