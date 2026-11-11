import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BrokkrError } from "./errors.js";

/**
 * True when `rel`, a `path.relative(base, target)` result, leaves `base`: `..`, a
 * leading `..` segment, or absolute (another drive). A name like `..generated` stays inside.
 */
export function escapesBase(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Check that `rel` names a regular file inside `base`: lexically contained,
 * not a symlink, and with a realpath inside the realpath of `base` (so no
 * symlinked directory on the way). Returns a problem description, or
 * undefined when the file is safe to read.
 */
export function checkContainedFile(base: string, rel: string): string | undefined {
  const abs = resolve(base, rel);
  const lexical = relative(resolve(base), abs);
  if (lexical === "" || escapesBase(lexical)) {
    return `'${rel}' resolves outside ${base}`;
  }
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (stat === undefined) return `'${rel}' does not exist`;
  if (stat.isSymbolicLink())
    return `'${rel}' is a symlink; symlinks are not allowed in harness packages`;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return `'${rel}' cannot be resolved`;
  }
  const realRel = relative(realpathSync(base), real);
  if (realRel === "" || escapesBase(realRel)) {
    return `'${rel}' resolves outside ${base} through a symlinked directory`;
  }
  if (!stat.isFile()) return `'${rel}' is not a regular file`;
  return undefined;
}

/** Read a file only after `checkContainedFile` passes; throws `policy-denied` otherwise. */
export async function readContainedFile(base: string, rel: string): Promise<string> {
  const problem = checkContainedFile(base, rel);
  if (problem) throw new BrokkrError("policy-denied", problem);
  return readFile(resolve(base, rel), "utf8");
}
