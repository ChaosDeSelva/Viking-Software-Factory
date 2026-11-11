import type { SqliteDatabase } from "@sindri/knowledge";

/**
 * The Mimir project settings Sindri derives from a project's execution profile: what agents
 * (and verification) need from the environment. Sindri owns exactly these two keys on the
 * Mimir project; every other setting there is left as it is.
 */
export interface ProfileProjectSettings {
  agent?: {
    env?: Record<string, string>;
    pathPrepend?: string[];
    codexSandbox?: { writableRoots?: string[]; networkAccess?: boolean };
  };
  verificationTimeoutMs?: number;
}
export const OWNED_SETTINGS = ["agent", "verificationTimeoutMs"] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : Object.keys(v ?? {}).length > 0;

/** Maps a stored (already validated) execution profile to Mimir project settings. */
export function settingsFromProfile(profile: Record<string, unknown>): ProfileProjectSettings {
  const agent: Record<string, unknown> = {};
  for (const key of ["env", "pathPrepend", "codexSandbox"])
    if (profile[key] !== undefined && nonEmpty(profile[key])) agent[key] = profile[key];
  const timeout = profile["verificationTimeoutMs"];
  return {
    ...(nonEmpty(agent) ? { agent } : {}),
    ...(typeof timeout === "number" ? { verificationTimeoutMs: timeout } : {}),
  };
}

/**
 * The settings for the Sindri project stored at `repoPath`, or undefined when no project there
 * ever had a profile set (Sindri then leaves the Mimir project's settings alone).
 */
export function profileSettingsFromDb(
  db: SqliteDatabase,
  repoPath: string,
): ProfileProjectSettings | undefined {
  // Databases opened by this package alone have no Sindri project table.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get())
    return undefined;
  const rows = db
    .prepare("SELECT settings_json FROM projects WHERE repo_path = ? ORDER BY created_at, rowid")
    .all(repoPath) as { settings_json: string }[];
  for (const row of rows) {
    const profile = (JSON.parse(row.settings_json) as Record<string, unknown>)["executionProfile"];
    if (isObject(profile)) return settingsFromProfile(profile);
  }
  return undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
