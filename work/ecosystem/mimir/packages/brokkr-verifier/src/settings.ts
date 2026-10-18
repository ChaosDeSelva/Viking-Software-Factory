import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { MimirError } from "@mimir/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * `ProjectSettings.verification`: what the project's verification contract is. Set by the
 * operator on the project, never read from a worktree. `harnesses` are `name@semver-range`
 * (`name` alone means any version). `lockPath` (required) and `policyPath` are absolute paths
 * to files outside the task worktree (JSON or YAML).
 */
export const VerificationSettingsSchema = z
  .strictObject({
    harnesses: z.array(z.string().min(1)).min(1),
    /** Required: `workspace-untrusted` verification needs pinned harness versions and digests. */
    lockPath: z.string().min(1).refine(isAbsolute, "must be an absolute path").optional(),
    lock: z.record(z.string(), z.unknown()).optional(),
    policyPath: z.string().min(1).refine(isAbsolute, "must be an absolute path").optional(),
  })
  .refine(
    (s) => (s.lockPath !== undefined) !== (s.lock !== undefined),
    "provide exactly one of lockPath or lock",
  );
export type VerificationSettings = z.infer<typeof VerificationSettingsSchema>;

const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** `documentation@^1` → `{ name: "documentation", version: "^1" }`; no `@` → version `*`. */
export function parseHarnessRef(ref: string): { name: string; version: string } {
  const at = ref.indexOf("@");
  const name = at === -1 ? ref : ref.slice(0, at);
  const version = at === -1 ? "*" : ref.slice(at + 1);
  if (!NAME.test(name) || version.trim() === "" || /\s/.test(name)) {
    throw new MimirError("validation_failed", `invalid harness reference "${ref}"`, {
      reason: "invalid_harness_ref",
      ref,
    });
  }
  return { name, version };
}

export function parseSettings(raw: unknown): VerificationSettings {
  const r = VerificationSettingsSchema.safeParse(raw);
  if (!r.success) {
    throw new MimirError(
      "validation_failed",
      "project settings.verification is missing or invalid",
      {
        reason: "verification_settings",
        issues: r.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      },
    );
  }
  return r.data;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/**
 * Reads a settings file (JSON or YAML) after resolving symlinks; a file that resolves inside
 * the task worktree is refused, so an agent cannot supply its own lock or policy.
 */
export function readSettingsFile(path: string, worktreePath: string, what: string): unknown {
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(worktreePath);
  } catch {
    throw new MimirError("validation_failed", `${what} file ${path} cannot be read`, {
      reason: "unreadable",
      path,
    });
  }
  if (inside(root, real)) {
    throw new MimirError("validation_failed", `${what} file must not come from the worktree`, {
      reason: "in_worktree",
      path,
    });
  }
  try {
    return parseYaml(readFileSync(real, "utf8")) as unknown;
  } catch (err) {
    throw new MimirError("validation_failed", `${what} file ${path} is not valid JSON or YAML`, {
      reason: "unparseable",
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
