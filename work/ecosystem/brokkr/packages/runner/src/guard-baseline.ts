import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import type { CheckDefinition } from "@brokkr/core";
import { GIT_SAFE_CONFIG, gitEnv } from "@brokkr/evidence";

/** A full SHA-1 or SHA-256 commit id: content-addressed, so the work under test cannot move it. */
export const BASE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type BaselineGuard =
  /** Every `when` condition held at the base commit: the check applied there. */
  | { status: "held" }
  /** The check did not apply at the base commit either. */
  | { status: "not_held"; detail: string }
  /** The base could not be consulted. */
  | { status: "unknown"; detail: string };

/** Run git with repo-controlled command execution disabled; resolves with stdout, or undefined on failure. */
function git(cwd: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((res) =>
    execFile(
      "git",
      [...GIT_SAFE_CONFIG, ...args],
      {
        cwd,
        // refs/replace could substitute another commit or tree for the base.
        env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1" },
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => res(error ? undefined : stdout),
    ),
  );
}

class Unverifiable extends Error {}

type Entry = { kind: "tree" | "file" | "other"; oid: string };

/**
 * Evaluate a check's `when` guard against the tree of `baseCommit` instead of
 * the working tree. In workspace-untrusted mode the working tree is written by
 * the work under test, so a guard that fails there proves nothing; the base
 * commit shows whether the check applied before that work.
 *
 * The object database is in the workspace too, and git does not verify an
 * object against its id when reading it, so every object read here is hashed
 * and compared with the id that names it: the work under test can make the
 * answer `unknown` (by deleting or corrupting objects) but cannot forge it.
 * Only `git cat-file` is run: no checkout, filters or hooks. The workspace
 * must be the repository's top level (git's idea of it is repository config,
 * which the work under test controls). Files that were untracked at the base
 * count as absent there.
 */
export async function whenHeldAtBase(
  when: NonNullable<CheckDefinition["when"]>,
  options: { workspace: string; cwd: string; baseCommit: string },
): Promise<BaselineGuard> {
  const { baseCommit } = options;
  const unknown = (detail: string): BaselineGuard => ({ status: "unknown", detail });
  if (!BASE_COMMIT.test(baseCommit)) return unknown(`'${baseCommit}' is not a full commit id`);
  const root = await realpath(options.workspace);
  const top = (await git(root, ["rev-parse", "--show-toplevel"]))?.toString("utf8").trim();
  if (!top) return unknown("the workspace is not a git repository");
  if ((await realpath(top)) !== root)
    return unknown("the workspace is not the top level of its git repository");
  const prefix = relative(root, resolve(root, options.cwd)).split(sep).join("/");
  if (prefix === ".." || prefix.startsWith("../") || posix.isAbsolute(prefix))
    return unknown(`check cwd '${options.cwd}' is outside the repository`);

  const algorithm = baseCommit.length === 40 ? "sha1" : "sha256";
  const oidBytes = baseCommit.length / 2;
  /** The object `oid` of `type`, verified against its id. */
  const object = async (type: "commit" | "tree" | "blob", oid: string): Promise<Buffer> => {
    const body = await git(root, ["cat-file", type, oid]);
    const actual =
      body && createHash(algorithm).update(`${type} ${body.length}\0`).update(body).digest("hex");
    if (actual !== oid)
      throw new Unverifiable(
        `${type} ${oid} is missing from the workspace repository or does not match its id`,
      );
    return body!;
  };
  const tree = async (oid: string): Promise<Map<string, Entry>> => {
    const body = await object("tree", oid);
    const entries = new Map<string, Entry>();
    for (let i = 0; i < body.length;) {
      const space = body.indexOf(0x20, i);
      const nul = body.indexOf(0, space);
      const mode = body.subarray(i, space).toString("latin1");
      const name = body.subarray(space + 1, nul).toString("utf8");
      const id = body.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
      entries.set(name, {
        kind: mode === "40000" ? "tree" : /^100[67]/.test(mode) ? "file" : "other",
        oid: id,
      });
      i = nul + 1 + oidBytes;
    }
    return entries;
  };

  const short = baseCommit.slice(0, 12);
  try {
    const commit = (await object("commit", baseCommit)).toString("utf8");
    const rootTree = /^tree ([0-9a-f]+)\n/.exec(commit)?.[1];
    if (rootTree === undefined) throw new Unverifiable(`commit ${baseCommit} has no tree`);

    /**
     * The entry at `file` (relative to the check cwd) in the base tree, or
     * undefined when nothing is there. A path outside the repository, or one
     * through a symlink or submodule, cannot be answered from the tree.
     */
    const lookup = async (file: string): Promise<Entry | undefined> => {
      const p = posix.normalize(posix.join(prefix, file));
      if (p === ".." || p.startsWith("../") || posix.isAbsolute(p))
        throw new Unverifiable(`'${file}' is outside the repository`);
      let entry: Entry = { kind: "tree", oid: rootTree };
      for (const part of p === "." ? [] : p.replace(/\/$/, "").split("/")) {
        if (entry.kind === "file") return undefined;
        if (entry.kind === "other")
          throw new Unverifiable(`'${file}' is under a symlink or submodule at base ${short}`);
        const entries = await tree(entry.oid);
        const next = entries.get(part);
        if (next === undefined) {
          // On a case-insensitive file system the working tree would have matched it.
          if ([...entries.keys()].some((name) => name.toLowerCase() === part.toLowerCase()))
            throw new Unverifiable(`'${file}' exists at base ${short} only in another letter case`);
          return undefined;
        }
        entry = next;
      }
      if (entry.kind === "other")
        throw new Unverifiable(`'${file}' is a symlink or submodule at base ${short}`);
      return entry;
    };

    for (const file of when.fileExists ?? [])
      if (!(await lookup(file)))
        return { status: "not_held", detail: `'${file}' did not exist at base ${short}` };
    if (when.anyFileExists) {
      let any = false;
      for (const file of when.anyFileExists) any ||= (await lookup(file)) !== undefined;
      if (!any)
        return {
          status: "not_held",
          detail: `none of ${when.anyFileExists.join(", ")} existed at base ${short}`,
        };
    }
    if (when.scriptExists && when.scriptExists.length > 0) {
      const pkg = await lookup("package.json");
      let scripts: object = {};
      if (pkg?.kind === "file") {
        const text = (await object("blob", pkg.oid)).toString("utf8");
        try {
          const parsed = JSON.parse(text) as { scripts?: unknown } | null;
          if (parsed?.scripts && typeof parsed.scripts === "object") scripts = parsed.scripts;
        } catch {
          // unparsable at base: no scripts, as in the working tree
        }
      }
      for (const name of when.scriptExists)
        if (!Object.hasOwn(scripts, name))
          return {
            status: "not_held",
            detail: `package.json had no '${name}' script at base ${short}`,
          };
    }
    return { status: "held" };
  } catch (error) {
    return unknown((error as Error).message);
  }
}
