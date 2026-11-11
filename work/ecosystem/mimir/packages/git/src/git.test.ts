import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TempDirs, makeRepo } from "../test/helpers.js";
import { auditRepoConfig, git } from "./git.js";

const dirs = new TempDirs();
let repo: string;

beforeEach(async () => {
  repo = await makeRepo(dirs);
});

afterEach(async () => {
  await dirs.cleanup();
});

describe("git", () => {
  it("rejects with internal when git cannot start in the directory", async () => {
    await expect(git(join(repo, "missing"), ["status"])).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("git failed to start"),
      details: { args: ["status"] },
    });
  });

  it("kills git and rejects once stdout passes the output cap", async () => {
    const big = Buffer.alloc(64 * 1024 * 1024 + 1);
    const { stdout } = await git(repo, ["hash-object", "-w", "--stdin"], { input: big });
    await expect(git(repo, ["cat-file", "blob", stdout.trim()])).rejects.toMatchObject({
      code: "internal",
      message: `git cat-file output exceeded ${64 * 1024 * 1024} bytes`,
    });
  }, 60_000);

  it("names an empty command in the failure message", async () => {
    await expect(git(repo, [])).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/^git {2}failed: /),
      details: { args: [] },
    });
  });
});

describe("auditRepoConfig", () => {
  it("refuses a valueless core.hooksPath and a valueless driver key", async () => {
    await appendFile(join(repo, ".git", "config"), '[core]\n\thooksPath\n[filter "x"]\n\tclean\n');
    await expect(auditRepoConfig(repo)).rejects.toMatchObject({
      code: "policy_denied",
      details: { keys: ["core.hookspath", "filter.x.clean"] },
    });
  });
});
