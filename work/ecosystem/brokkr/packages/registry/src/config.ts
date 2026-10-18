import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  BrokkrError,
  HarnessLockSchema,
  ProjectConfigSchema,
  formatIssues,
  parseManifestText,
  validateWith,
  type HarnessLock,
  type ProjectConfig,
} from "@brokkr/core";

/** Project configuration, relative to the repository root. */
export const CONFIG_FILE = ".brokkr/config.yaml";
/** Harness lockfile, relative to the repository root. */
export const LOCK_FILE = ".brokkr/harness.lock.json";

/**
 * Ensure `<cwd>/.brokkr` is a real directory (created if missing). A
 * pre-existing symlink is refused so Brokkr never writes through it.
 */
export async function ensureBrokkrDir(cwd: string): Promise<string> {
  const dir = join(cwd, ".brokkr");
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    throw new BrokkrError(
      "policy-denied",
      `${dir} is a symlink; refusing to write Brokkr state through it`,
    );
  }
  if (stat && !stat.isDirectory())
    throw new BrokkrError("invalid-config", `${dir} exists and is not a directory`);
  if (!stat) await mkdir(dir);
  return dir;
}

/** Read `.brokkr/config.yaml`; returns undefined when absent, throws `invalid-config` when malformed. */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig | undefined> {
  const file = join(cwd, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  const result = parseManifestText(await readFile(file, "utf8"), ProjectConfigSchema, CONFIG_FILE);
  if (!result.ok) {
    throw new BrokkrError(
      "invalid-config",
      `invalid ${CONFIG_FILE}:\n${formatIssues(result.issues)}`,
      {
        details: { issues: result.issues },
      },
    );
  }
  return result.value;
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<string> {
  const valid = validateWith(ProjectConfigSchema, config);
  if (!valid.ok) throw new BrokkrError("invalid-config", formatIssues(valid.issues));
  const file = join(cwd, CONFIG_FILE);
  await ensureBrokkrDir(cwd);
  await writeFile(file, stringify(config));
  return file;
}

/** Read and schema-validate the lockfile; undefined when absent. */
export async function readLock(cwd: string): Promise<HarnessLock | undefined> {
  const file = join(cwd, LOCK_FILE);
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, "utf8");
  try {
    const raw = JSON.parse(text) as { lockVersion?: unknown };
    if (raw.lockVersion === 1) {
      throw new BrokkrError(
        "invalid-config",
        `${LOCK_FILE} uses lockVersion 1, which allowed .brokkrignore exclusions and is no longer accepted; regenerate it with \`brokkr harness lock\``,
      );
    }
  } catch (error) {
    if (error instanceof BrokkrError) throw error;
  }
  const result = parseManifestText(text, HarnessLockSchema, LOCK_FILE);
  if (!result.ok) {
    throw new BrokkrError(
      "invalid-config",
      `invalid ${LOCK_FILE}:\n${formatIssues(result.issues)}`,
      {
        details: { issues: result.issues },
      },
    );
  }
  return result.value;
}
