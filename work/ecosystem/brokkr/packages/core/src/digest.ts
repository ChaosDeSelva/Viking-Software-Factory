import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

export function sha256Digest(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export async function fileDigest(file: string): Promise<string> {
  return sha256Digest(await readFile(file));
}

/** List every regular file under `dir` as sorted POSIX relative paths. No implicit skips; throws on symlinks. */
export async function listTreeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = join(abs, entry.name);
      const childRel = rel === "" ? entry.name : posix.join(rel, entry.name);
      const stat = await lstat(childAbs);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing to hash symlink '${childRel}' in ${dir}`);
      }
      if (stat.isDirectory()) await walk(childAbs, childRel);
      else if (stat.isFile()) out.push(childRel);
      else throw new Error(`refusing to hash special file '${childRel}' in ${dir}`);
    }
  }
  await walk(dir, "");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface TreeManifest {
  digest: string;
  /** Every file covered by the digest (sorted). Nothing is ever excluded. */
  files: string[];
}

/**
 * Deterministic SHA-256 tree hash of a directory: for every regular file in
 * sorted relative-path order, hash `path NUL sha256(bytes) LF`. Every regular
 * file is covered; there is no ignore mechanism. Symlinks, FIFOs, sockets and
 * devices are rejected so the digest always covers the bytes that will be read.
 */
export async function treeManifest(dir: string): Promise<TreeManifest> {
  const files = await listTreeFiles(dir);
  const hash = createHash("sha256");
  for (const rel of files) {
    const bytes = await readFile(join(dir, ...rel.split("/")));
    hash.update(rel);
    hash.update("\0");
    hash.update(createHash("sha256").update(bytes).digest("hex"));
    hash.update("\n");
  }
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

export async function treeDigest(dir: string): Promise<string> {
  return (await treeManifest(dir)).digest;
}

/** JSON with object keys sorted recursively; stable input for content digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
