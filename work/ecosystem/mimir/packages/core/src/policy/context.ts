import type { PrivilegedAction } from "./actions.js";
import type { PathContext } from "./paths.js";

export type Result = PrivilegedAction | null;

export const UNCLASSIFIED = "shell.unclassified" satisfies PrivilegedAction;
export const DESTRUCTIVE = "shell.destructive" satisfies PrivilegedAction;
export const SECRET_READ = "secret.read" satisfies PrivilegedAction;
export const PACKAGE_INSTALL = "package.install" satisfies PrivilegedAction;
export const PACKAGE_INSTALL_GLOBAL = "package.install_global" satisfies PrivilegedAction;
export const EXTERNAL_WRITE = "network.external_write" satisfies PrivilegedAction;

/** Mutable state threaded through the commands of one command line. */
export interface Ctx extends PathContext {
  /**
   * Branches that may be checked out. Grows (never shrinks) as `checkout`/`switch`/`cd` run,
   * because a step may fail and the line continue. `undefined` means unknown.
   */
  branches: Set<string | undefined>;
  protectedBranches: readonly string[];
}

export function isSpecific(r: Result): r is PrivilegedAction {
  return r !== null && r !== UNCLASSIFIED;
}

/** First specific action; otherwise unclassified if any part was; otherwise null. */
export function combine(results: Iterable<Result>): Result {
  let unclassified = false;
  for (const r of results) {
    if (isSpecific(r)) return r;
    if (r === UNCLASSIFIED) unclassified = true;
  }
  return unclassified ? UNCLASSIFIED : null;
}
