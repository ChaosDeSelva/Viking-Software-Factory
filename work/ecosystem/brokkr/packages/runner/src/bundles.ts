import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const MAX_BUNDLE_FILES = 5_000;
export const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BUNDLE_DEPTH = 16;

export interface BundleRead {
  files: Array<{ file: string; text: string }>;
  warnings: string[];
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Read `<workspace>/.brokkr/generated` for the post-run secret scan (fix round 2,
 * N2). Called after the checks have run, so nothing a check does in between
 * can be missed. The workspace is hostile, so containment is enforced at read
 * time: directories are entered only if `lstat` says they are real directories
 * whose realpath is inside the workspace, and each file is opened with
 * `O_NOFOLLOW | O_NONBLOCK` and `fstat`-checked on the handle (regular file,
 * same inode as listed, not a hard link, size within the cap) before at most
 * `cap` bytes are read. Entry count and directory depth are capped. Symlinks, FIFOs, devices and swaps become warnings, never reads.
 */
export async function readGeneratedBundles(
  workspace: string,
  caps: { maxFiles?: number; maxBytes?: number; maxDepth?: number } = {},
): Promise<BundleRead> {
  const maxFiles = caps.maxFiles ?? MAX_BUNDLE_FILES;
  const maxDepth = caps.maxDepth ?? MAX_BUNDLE_DEPTH;
  let visited = 0;
  let stopped = false;
  const maxBytes = caps.maxBytes ?? MAX_BUNDLE_FILE_BYTES;
  const out: BundleRead = { files: [], warnings: [] };
  const root = await realpath(workspace);
  const rel = (p: string) => relative(workspace, p);
  const refuse = (p: string, why: string) => out.warnings.push(`refused to scan ${rel(p)}: ${why}`);

  const enterable = async (dir: string): Promise<boolean> => {
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) {
      refuse(dir, "it is a symlink");
      return false;
    }
    if (!st.isDirectory()) return false;
    if (!inside(root, await realpath(dir))) {
      refuse(dir, "it resolves outside the workspace");
      return false;
    }
    return true;
  };

  const readOne = async (file: string): Promise<void> => {
    let listed;
    try {
      listed = await lstat(file);
    } catch {
      return;
    }
    if (listed.isSymbolicLink()) return void refuse(file, "it is a symlink");
    if (!listed.isFile()) return void refuse(file, "it is not a regular file");
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return void refuse(
        file,
        code === "ELOOP" ? "it is a symlink (swapped after listing)" : `cannot open (${code})`,
      );
    }
    try {
      const st = await handle.stat();
      if (!st.isFile())
        return void refuse(file, "it is not a regular file (swapped after listing)");
      if (st.ino !== listed.ino || st.dev !== listed.dev)
        return void refuse(file, "it was replaced after listing");
      // A hard link shares an inode with a file that may live outside the workspace (I-a).
      if (st.nlink > 1) return void refuse(file, "it is a hard link");
      if (!inside(root, await realpath(join(file, ".."))))
        return void refuse(file, "it resolves outside the workspace");
      if (st.size > maxBytes) return void refuse(file, `larger than ${maxBytes} bytes`);
      const buf = Buffer.alloc(Math.min(st.size, maxBytes));
      let offset = 0;
      while (offset < buf.length) {
        const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      out.files.push({ file, text: buf.subarray(0, offset).toString("utf8") });
    } finally {
      await handle.close();
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (stopped) return;
    if (depth > maxDepth) return void refuse(dir, `deeper than ${maxDepth} levels`);
    if (!(await enterable(dir))) return;
    for (const name of (await readdir(dir)).sort()) {
      if (stopped) return;
      // Every entry counts toward the cap, read or refused, files and directories alike (m-a).
      if (++visited > maxFiles) {
        stopped = true;
        out.warnings.push(`stopped scanning generated bundles after ${maxFiles} entries`);
        return;
      }
      const p = join(dir, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(p, depth + 1);
      else await readOne(p);
    }
  };

  if (await enterable(join(workspace, ".brokkr")))
    await walk(join(workspace, ".brokkr", "generated"), 1);
  return out;
}
