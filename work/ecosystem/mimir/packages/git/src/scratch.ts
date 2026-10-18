import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MimirError } from "@mimir/protocol";
import { git, type GitOptions, type GitResult } from "./git.js";

export interface SnapshotResult {
  /** Tree object for the working tree (equals HEAD's tree when nothing changed). */
  tree: string;
  /** Paths whose content, mode or presence differs from HEAD. */
  changed: string[];
}

interface TreeEntry {
  mode: string;
  sha: string;
}

/** True when any directory strictly between `root` and `abs` is a symlink. Missing is fine. */
async function hasSymlinkedAncestor(root: string, abs: string): Promise<boolean> {
  const parts = relative(root, abs).split(sep).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const st = await lstat(current).catch(() => undefined);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false;
  }
  return false;
}

/**
 * A Mimir-owned bare repository that borrows a project's objects through
 * `objects/info/alternates`. Read-only analysis (diff, log, merge-tree) runs here so git never
 * reads the project's agent-writable config or attributes: no filter, merge, diff or gpg driver
 * defined by an agent exists in this repository. Global and system config are disabled too.
 */
export class ScratchRepo {
  private constructor(readonly gitDir: string) {}

  static async open(scratchRoot: string, name: string, repoPath: string): Promise<ScratchRepo> {
    const gitDir = join(scratchRoot, `${name}.git`);
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = new ScratchRepo(gitDir);
    const head = await lstat(join(gitDir, "HEAD")).catch(() => undefined);
    if (!head) {
      await rm(gitDir, { recursive: true, force: true });
      await git(scratchRoot, ["init", "--quiet", "--bare", "--template=", gitDir], {
        env: { GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    }
    // Rewrite config and alternates every time we open: the scratch repo is ours alone.
    await writeFile(
      join(gitDir, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
    );
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "attributes"), "");
    const common = (await git(repoPath, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const objects = await realpath(
      join(isAbsolute(common) ? common : resolve(repoPath, common), "objects"),
    );
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`);
    return scratch;
  }

  /** Runs git against the scratch repo (GIT_DIR) with global config disabled. */
  run(args: string[], options: GitOptions & { cwd?: string } = {}): Promise<GitResult> {
    return git(options.cwd ?? this.gitDir, args, {
      ...options,
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...options.env,
        GIT_DIR: this.gitDir,
      },
    });
  }

  /** Every blob/gitlink entry of `treeish`, keyed by path. */
  async treeEntries(treeish: string): Promise<Map<string, TreeEntry>> {
    const r = await this.run(["ls-tree", "-r", "-z", "--full-tree", treeish]);
    const map = new Map<string, TreeEntry>();
    for (const rec of r.stdout.split("\0")) {
      const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(rec);
      if (m?.[1] && m[2] && m[3] !== undefined) map.set(m[3], { mode: m[1], sha: m[2] });
    }
    return map;
  }

  /**
   * Builds a tree object for the working tree at `worktreePath` on top of `headSha` without
   * running any filter or following any symlink:
   * - a path with a symlinked ancestor directory is a `policy_denied` (never read through);
   * - files are opened with O_NOFOLLOW|O_NONBLOCK, fstat-checked to be regular and to match the
   *   lstat taken before opening, and their raw bytes go to `hash-object -w --no-filters --stdin`;
   * - symlinks are stored as links (target text only); FIFOs, sockets and devices are ignored;
   * - gitlinks keep HEAD's entry (callers reject nested repositories beforehand).
   */
  async snapshot(
    worktreePath: string,
    headSha: string,
    paths: string[],
    exclude: Set<string>,
  ): Promise<SnapshotResult> {
    const head = await this.treeEntries(headSha);
    const algo = (await this.run(["rev-parse", "--show-object-format"])).stdout.trim() || "sha1";
    const zero = "0".repeat(algo === "sha256" ? 64 : 40);
    const lines: string[] = [];
    const changed: string[] = [];
    const violations: string[] = [];

    const record = async (path: string, mode: string, data: Buffer) => {
      const id = createHash(algo).update(`blob ${data.length}\0`).update(data).digest("hex");
      const prev = head.get(path);
      if (prev && prev.mode === mode && prev.sha === id) return;
      const written = (
        await this.run(["hash-object", "-w", "--no-filters", "--stdin"], { input: data })
      ).stdout.trim();
      if (written !== id) {
        throw new MimirError("internal", "blob id mismatch while snapshotting", { path });
      }
      lines.push(`${mode} ${id}\t${path}`);
      changed.push(path);
    };
    const remove = (path: string) => {
      if (!head.has(path)) return;
      lines.push(`0 ${zero}\t${path}`);
      changed.push(path);
    };

    for (const path of paths) {
      if (exclude.has(path) || path.endsWith("/")) continue;
      if (head.get(path)?.mode === "160000") continue;
      const abs = join(worktreePath, path);
      if (await hasSymlinkedAncestor(worktreePath, abs)) {
        violations.push(path);
        continue;
      }
      const st = await lstat(abs).catch(() => undefined);
      if (!st) {
        remove(path);
      } else if (st.isSymbolicLink()) {
        await record(path, "120000", Buffer.from(await readlink(abs)));
      } else if (st.isFile()) {
        const fh = await open(
          abs,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch(() => undefined);
        if (!fh) {
          violations.push(path);
          continue;
        }
        try {
          const fst = await fh.stat();
          if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) {
            violations.push(path);
            continue;
          }
          const data = await fh.readFile();
          // Re-check after reading: an ancestor swapped to a symlink mid-read is a violation.
          if (await hasSymlinkedAncestor(worktreePath, abs)) {
            violations.push(path);
            continue;
          }
          await record(path, fst.mode & 0o111 ? "100755" : "100644", data);
        } finally {
          await fh.close();
        }
      } else {
        // Directory where a file was, FIFO, socket, device: not representable; treat as absent.
        remove(path);
      }
    }

    if (violations.length > 0) {
      throw new MimirError(
        "policy_denied",
        "working tree contains paths reached through a symlinked directory",
        { paths: violations.sort() },
      );
    }
    const headTree = (await this.run(["rev-parse", `${headSha}^{tree}`])).stdout.trim();
    if (lines.length === 0) return { tree: headTree, changed: [] };

    const dir = join(this.gitDir, `tmp-index-${randomUUID()}`);
    await mkdir(dir, { mode: 0o700 });
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      await this.run(["read-tree", headSha], { env });
      await this.run(["update-index", "-z", "--index-info"], {
        env,
        input: lines.map((l) => `${l}\0`).join(""),
      });
      const tree = (await this.run(["write-tree"], { env })).stdout.trim();
      return { tree, changed: changed.sort() };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
