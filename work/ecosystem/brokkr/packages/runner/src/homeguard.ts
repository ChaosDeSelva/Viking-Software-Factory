import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Digest of every file under `<home>/.brokkr` except Brokkr's own run store,
 * keyed by relative path (symlinks by their target, never followed). Used to
 * detect a check that rewrites the Brokkr home (config, lock, exceptions,
 * org policy, user harnesses, key) during a workspace-untrusted run.
 */
export async function brokkrHomeSnapshot(home: string): Promise<Map<string, string>> {
  const root = join(home, ".brokkr");
  const out = new Map<string, string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (childRel === "runs") continue;
      const abs = join(dir, e.name);
      const st = await lstat(abs).catch(() => undefined);
      if (!st) continue;
      if (st.isSymbolicLink()) out.set(childRel, `link:${await readlink(abs)}`);
      else if (st.isDirectory()) await walk(abs, childRel);
      else if (st.isFile())
        out.set(
          childRel,
          createHash("sha256")
            .update(await readFile(abs))
            .digest("hex"),
        );
      else out.set(childRel, "special");
    }
  };
  await walk(root, "");
  return out;
}

/** Relative paths added, removed or changed between two snapshots. */
export function snapshotChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of before) if (after.get(k) !== v) changed.add(k);
  for (const k of after.keys()) if (!before.has(k)) changed.add(k);
  return [...changed].sort();
}
