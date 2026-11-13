import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { RepoReader } from "@sindri/delivery";
import { hardenedGitEnv, HARDENED_GIT_CONFIG } from "@sindri/knowledge";

const run = promisify(execFile);

/** Largest cited file whose lines are counted. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Read-only lookups in a project's repository: `git cat-file` and `git show <commit>:<path>` under
 * the hardened git config, so nothing the repository configures can run. Used to check research
 * citations against the commit the research task read.
 */
export function gitRepoReader(repoPathOf: (projectId: string) => string | undefined): RepoReader {
  const git = async (repo: string, args: string[], maxBuffer: number) =>
    (
      await run("git", [...HARDENED_GIT_CONFIG, ...args], {
        cwd: repo,
        env: { ...hardenedGitEnv(), GIT_LFS_SKIP_SMUDGE: "1" },
        timeout: 15_000,
        maxBuffer,
        encoding: "buffer",
      })
    ).stdout;
  return {
    async lineCount(projectId, commit, path) {
      const repo = repoPathOf(projectId);
      if (!repo || !existsSync(repo)) throw new RepoReadError("repo_unavailable");
      if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new RepoReadError("commit_invalid");
      try {
        await git(
          repo,
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}^{commit}`],
          4096,
        );
      } catch (err) {
        throw new RepoReadError(exitedNonZero(err) ? "commit_unresolvable" : "git_failed");
      }
      const spec = `${commit}:${path}`;
      let type: string;
      try {
        type = (await git(repo, ["cat-file", "-t", "--end-of-options", spec], 4096))
          .toString("utf8")
          .trim();
      } catch (err) {
        // The commit resolves, so a git that ran and refused means the path is not in it.
        if (exitedNonZero(err)) return null;
        throw new RepoReadError("git_failed");
      }
      if (type !== "blob") return null;
      let bytes: Buffer;
      try {
        bytes = await git(repo, ["cat-file", "blob", "--end-of-options", spec], MAX_FILE_BYTES);
      } catch {
        throw new RepoReadError("git_failed");
      }
      if (bytes.length === 0) return 0;
      const text = bytes.toString("utf8");
      const lines = text.split("\n").length;
      return text.endsWith("\n") ? lines - 1 : lines;
    },
  };
}

/** Why a cited file could not be checked; the message is the reason code the gate reports. */
export class RepoReadError extends Error {
  override readonly name = "RepoReadError";
}

/** git ran and exited with a status (not killed by the timeout, not missing). */
const exitedNonZero = (err: unknown) =>
  typeof (err as { code?: unknown }).code === "number" && !(err as { killed?: boolean }).killed;
