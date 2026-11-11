import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureProfileHarness,
  ExecutionProfileSchema,
  type ExecutionProfile,
  type HarnessRequest,
} from "@sindri/harnesses";
import type { Project } from "@sindri/knowledge";

/** Key of the execution profile inside a project's `settings`. */
export const PROFILE_KEY = "executionProfile";

/**
 * The directory whose `.brokkr/harnesses` Sindri's Brokkr loads as trusted user harnesses and
 * where generated profile harnesses are written. Mimir's Brokkr reads the same place under its
 * own home, so the default is the OS home; `SINDRI_BROKKR_HOME` moves it (tests).
 */
export function brokkrHome(env: Record<string, string | undefined> = process.env): string {
  return env["SINDRI_BROKKR_HOME"] || homedir();
}

/** The project's stored profile; empty when none was set (or the stored value is invalid). */
export function profileOf(project: Pick<Project, "settings">): ExecutionProfile {
  const parsed = ExecutionProfileSchema.safeParse(project.settings[PROFILE_KEY] ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * The generated harness of a project's profile, written if missing; null without checks.
 * Writing an existing harness is a no-op, so this is safe to call on every plan request.
 */
export function profileHarness(
  project: Pick<Project, "name" | "settings">,
  profile: ExecutionProfile = profileOf(project),
): HarnessRequest | null {
  return ensureProfileHarness(join(brokkrHome(), ".brokkr", "harnesses"), project.name, profile);
}
