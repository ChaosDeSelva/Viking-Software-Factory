import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { z } from "zod";
import type { HarnessRequest } from "./types.js";

/**
 * A project's execution profile: how the repository is checked and what its tools need.
 * Operator configuration, stored with the Sindri project; never read from a repository.
 */

/**
 * Never set from a profile: PATH and HOME, what Brokkr's runner refuses as code injection, and
 * Mimir's own variables (Mimir rejects those in project settings).
 */
const FORBIDDEN_ENV =
  /^(PATH|HOME|MIMIR_.*|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|GIT_.*|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"), "must not contain NUL");
const hasControlChar = (v: string) =>
  [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Same rule as Brokkr's `RelativePathSchema`: relative, no backslash, no `..` after normalising. */
function staysInside(p: string): boolean {
  if (p.includes("\\") || posix.isAbsolute(p) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return false;
  const n = posix.normalize(p);
  return n !== ".." && !n.startsWith("../");
}

const AbsoluteDir = text(1024)
  .refine((p) => isAbsolute(p) && !hasControlChar(p), "must be an absolute path")
  .refine((p) => !p.includes(":"), "must not contain ':'")
  .refine((p) => posix.normalize(p) !== "/", "must not be /")
  .refine((p) => !p.split("/").includes(".."), "must not contain '..'");

export const ProfileCheckSchema = z.strictObject({
  id: z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lowercase letters, digits, '.', '_' or '-'"),
  title: z.string().trim().min(1).max(200).optional(),
  /** argv; run without a shell. */
  command: z.array(text(4096)).min(1).max(64),
  /** Relative to the repository root. */
  cwd: text(1024)
    .refine(staysInside, "must be a relative path that stays inside the repository")
    .optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  /** Default true. */
  required: z.boolean().optional(),
});
export type ProfileCheck = z.infer<typeof ProfileCheckSchema>;

export const ExecutionProfileSchema = z
  .strictObject({
    checks: z.array(ProfileCheckSchema).max(20).optional(),
    /** Network policy for the checks. Default `deny`. */
    network: z.enum(["deny", "allow"]).optional(),
    /** Variables the checks and the agents need. */
    env: z
      .record(
        z
          .string()
          .max(128)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
          .refine((n) => !FORBIDDEN_ENV.test(n), "this variable cannot be set from a profile"),
        z
          .string()
          .max(4096)
          .refine((v) => !v.includes("\0"), "must not contain NUL")
          // Mimir refuses credential-shaped project settings; say so here, when the profile is
          // saved, instead of when a run is started.
          .refine(
            (v) => !/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v),
            "must not embed a password in a URL; keep credentials out of the profile",
          ),
      )
      .refine((e) => Object.keys(e).length <= 64, "at most 64 variables")
      .optional(),
    /** Absolute directories put first on PATH. */
    pathPrepend: z.array(AbsoluteDir).max(16).optional(),
    codexSandbox: z
      .strictObject({
        writableRoots: z.array(AbsoluteDir).max(16).optional(),
        networkAccess: z.boolean().optional(),
      })
      .optional(),
    verificationTimeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
  })
  .superRefine((p, ctx) => {
    const checks = p.checks ?? [];
    const seen = new Set<string>();
    checks.forEach((c, i) => {
      if (seen.has(c.id))
        ctx.addIssue({
          code: "custom",
          path: ["checks", i, "id"],
          message: `duplicate check id '${c.id}'`,
        });
      seen.add(c.id);
    });
    // Brokkr's verdict is `incomplete` when no required check applies.
    if (checks.length > 0 && !checks.some((c) => c.required !== false))
      ctx.addIssue({
        code: "custom",
        path: ["checks"],
        message: "at least one check must be required",
      });
  });
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const PROFILE_HARNESS_VERSION = "1.0.0";
const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "project";

/**
 * The Brokkr harness manifest for a profile, or null when the profile has no checks. The name
 * is `sindri-<project slug>-<8 hex of the content hash>`: a different profile is a different
 * harness, so a plan approved against one keeps resolving to the content it was locked to.
 * Only variable names enter the manifest; values are supplied where the checks run.
 */
export function profileHarnessManifest(
  projectName: string,
  profile: ExecutionProfile,
): { name: string; manifest: Record<string, unknown> } | null {
  const checks = profile.checks ?? [];
  if (checks.length === 0) return null;
  const env = Object.keys(profile.env ?? {}).sort();
  const body = {
    // No task types: Brokkr's own selection by task type must never pick this harness for
    // another project that shares the harness directory. Sindri names it explicitly instead.
    compatibility: { platforms: ["darwin", "linux", "win32"], taskTypes: [] },
    skills: { required: [], optional: [] },
    workflow: { stages: ["implement", "verify"] },
    checks: checks.map((c) => ({
      id: c.id,
      command: c.command,
      required: c.required ?? true,
      timeoutSeconds: c.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      ...(env.length > 0 ? { env } : {}),
    })),
    policies: {
      network: profile.network ?? "deny",
      destructiveCommands: "deny",
      requireApprovalFor: [],
    },
    evidence: { captureLogs: true, captureTestResults: false, captureScreenshots: false },
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 8);
  const name = `sindri-${slug(projectName)}-${hash}`;
  return {
    name,
    manifest: {
      apiVersion: "brokkr.dev/v1alpha1",
      kind: "Harness",
      metadata: {
        name,
        version: PROFILE_HARNESS_VERSION,
        description: "Checks from the project's Sindri execution profile",
      },
      ...body,
    },
  };
}

/**
 * Writes the profile's harness to `<harnessRoot>/<name>/harness.json` unless that directory
 * exists, and returns its reference; null when the profile has no checks. Existing directories
 * are never rewritten or removed: plans are locked to their digests.
 */
export function ensureProfileHarness(
  harnessRoot: string,
  projectName: string,
  profile: ExecutionProfile,
): HarnessRequest | null {
  const built = profileHarnessManifest(projectName, profile);
  if (!built) return null;
  const ref = { name: built.name, version: PROFILE_HARNESS_VERSION };
  const dir = join(harnessRoot, built.name);
  if (existsSync(join(dir, "harness.json"))) return ref;
  mkdirSync(harnessRoot, { recursive: true });
  // Written beside the target and renamed, so a reader never sees a partial harness. The
  // leading dot keeps Brokkr's harness discovery from loading a leftover.
  const tmp = mkdtempSync(join(harnessRoot, `.${built.name}-`));
  try {
    writeFileSync(join(tmp, "harness.json"), `${JSON.stringify(built.manifest, null, 2)}\n`);
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(dir, "harness.json"))) throw err;
  }
  return ref;
}
