import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { escapesBase } from "./contained.js";
import { BrokkrError } from "./errors.js";
import { isSafeRelativePath } from "./schemas.js";

/**
 * Create (if needed) `<base>/<rel>` for Brokkr state, refusing to traverse or
 * create through symlinks: every component is lstat-checked and must be a real
 * directory, and the final realpath must stay inside the base realpath.
 * Returns the absolute directory path.
 */
export async function ensureSafeDir(base: string, rel: string): Promise<string> {
  if (!isSafeRelativePath(rel))
    throw new BrokkrError("policy-denied", `state directory '${rel}' escapes ${base}`);
  // The base itself (workspace or Brokkr home) is caller-chosen; create it if missing.
  await mkdir(base, { recursive: true });
  const realBase = await realpath(base);
  let current = base;
  for (const part of rel.split("/").filter((p) => p !== "" && p !== ".")) {
    current = join(current, part);
    let st = await lstat(current).catch(() => undefined);
    if (st === undefined) {
      try {
        await mkdir(current);
        continue;
      } catch (error) {
        // A concurrent caller created it first: check what is there now like any existing entry.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      st = await lstat(current);
    }
    if (st.isSymbolicLink())
      throw new BrokkrError(
        "policy-denied",
        `${current} is a symlink; refusing to use it for Brokkr state`,
      );
    if (!st.isDirectory())
      throw new BrokkrError("invalid-config", `${current} exists and is not a directory`);
  }
  const final = relative(realBase, await realpath(current));
  if (escapesBase(final))
    throw new BrokkrError("policy-denied", `${current} resolves outside ${base}`);
  return current;
}
