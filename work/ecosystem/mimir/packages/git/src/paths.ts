import { lstat } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { MimirError } from "@mimir/protocol";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const MAX_SLUG_LENGTH = 40;

/**
 * Validates a caller-supplied absolute path. Any `..` segment is rejected outright (before and
 * after normalization), as are relative paths and NUL bytes. Returns the normalized path without a
 * trailing separator.
 */
export function assertSafeAbsolutePath(p: string, field: string): string {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    throw new MimirError("validation_failed", `${field} must be a non-empty path`, { field });
  }
  if (!isAbsolute(p)) {
    throw new MimirError("validation_failed", `${field} must be absolute`, { field, path: p });
  }
  const hasDotDot = (s: string) => s.split(/[\\/]+/).includes("..");
  const normalized = normalize(p);
  if (hasDotDot(p) || hasDotDot(normalized)) {
    throw new MimirError("validation_failed", `${field} must not contain '..' segments`, {
      field,
      path: p,
    });
  }
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/** Slugs used in branch names: lowercase `[a-z0-9-]`, 1..40 chars, no leading/trailing dash. */
export function assertSlug(s: string, field: string): void {
  if (typeof s !== "string" || s.length > MAX_SLUG_LENGTH || !SLUG_RE.test(s)) {
    throw new MimirError(
      "validation_failed",
      `${field} must match [a-z0-9-] (max ${MAX_SLUG_LENGTH} chars)`,
      { field, value: s },
    );
  }
}

export function branchNameFor(crewSlug: string, taskId: string, taskSlug: string): string {
  return `mimir/${crewSlug}/${taskId}-${taskSlug}`;
}

/** True when `child` equals `parent` or is a descendant of it (both absolute, normalized). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walks every path component strictly below `root` down to `target` and rejects any that is a
 * symlink. Missing components are fine (they will be created). `root` itself is trusted.
 */
export async function assertNoSymlinkBelow(root: string, target: string): Promise<void> {
  if (!isInside(target, root)) {
    throw new MimirError("validation_failed", "target is outside the worktree root", {
      root,
      target,
    });
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = `${current}${sep}${part}`;
    let st;
    try {
      st = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new MimirError("validation_failed", "symlinked worktree path rejected", {
        path: current,
      });
    }
  }
}
