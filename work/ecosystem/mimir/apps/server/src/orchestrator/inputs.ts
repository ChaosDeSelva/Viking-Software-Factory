import { lstat, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INPUTS_DIR } from "@mimir/git";
import type { Artifact } from "@mimir/protocol";
import { ARTIFACT_COLLECTION_DIR } from "./collect.js";

export { INPUTS_DIR };

/** Collected files besides `report`s that a dependency's dependents get to read. */
const INPUT_FILE_NAMES: ReadonlySet<string> = new Set(["sources.json", "review.json"]);

/** `task.failed.reason` prefix when the worktree's `.mimir` cannot be used (not retried). */
export const WORKSPACE_INVALID = "workspace_invalid";

/** The worktree's `.mimir` is a symlink or not a directory: no attempt can use it. */
export class WorkspaceInvalidError extends Error {}

export interface DependencyInput {
  dependencyTaskId: string;
  dir: string;
  files: string[];
}

export interface PlannedInput {
  dependencyTaskId: string;
  dir: string;
  files: { name: string; content: Buffer }[];
}

/** The newest artifact per file name among those a dependent receives. */
export function inputArtifacts(
  artifacts: readonly Artifact[],
  nameOf: (artifactId: string) => string | undefined,
): Map<string, Artifact> {
  const byName = new Map<string, Artifact>();
  for (const a of artifacts) {
    const name = nameOf(a.id);
    if (name === undefined) continue;
    if (a.kind === "report" || INPUT_FILE_NAMES.has(name)) byName.set(name, a);
  }
  return byName;
}

const lstatOrNull = (path: string) => lstat(path).catch(() => null);

/**
 * Readies a worktree for an attempt: `.mimir` must be a real directory (or absent), the
 * top-level files of `.mimir/artifacts/` left by earlier attempts are removed (they were
 * collected, or belong to a failed attempt), and `.mimir/inputs/` is removed. A symlinked
 * `artifacts` or `inputs` is removed itself, never followed.
 */
export async function prepareWorkspace(worktreePath: string): Promise<void> {
  const mimir = await lstatOrNull(join(worktreePath, ".mimir"));
  if (mimir?.isSymbolicLink()) throw new WorkspaceInvalidError(".mimir is a symlink");
  if (mimir && !mimir.isDirectory()) throw new WorkspaceInvalidError(".mimir is not a directory");
  if (!mimir) return;
  const artifacts = join(worktreePath, ARTIFACT_COLLECTION_DIR);
  const st = await lstatOrNull(artifacts);
  if (st && !st.isDirectory()) {
    await rm(artifacts, { force: true });
  } else if (st) {
    for (const name of await readdir(artifacts)) {
      const entry = await lstatOrNull(join(artifacts, name));
      if (entry && (entry.isFile() || entry.isSymbolicLink())) await unlink(join(artifacts, name));
    }
  }
  await rm(join(worktreePath, INPUTS_DIR), { recursive: true, force: true });
}

/** Writes each dependency's files to `.mimir/inputs/<dir>/` (after `prepareWorkspace`). */
export async function writeInputs(
  worktreePath: string,
  planned: readonly PlannedInput[],
): Promise<DependencyInput[]> {
  const placed: DependencyInput[] = [];
  for (const p of planned) {
    const dir = join(worktreePath, INPUTS_DIR, p.dir);
    await mkdir(dir, { recursive: true });
    for (const f of p.files) await writeFile(join(dir, f.name), f.content, { flag: "wx" });
    placed.push({
      dependencyTaskId: p.dependencyTaskId,
      dir: p.dir,
      files: p.files.map((f) => f.name).sort(),
    });
  }
  return placed;
}

/** One line for the agent brief naming the placed input files. */
export function inputsNote(inputs: readonly DependencyInput[]): string | undefined {
  const paths = inputs.flatMap((i) => i.files.map((f) => `${INPUTS_DIR}/${i.dir}/${f}`));
  if (paths.length === 0) return undefined;
  return `Results of the tasks this one depends on are in read-only copies: ${paths.join(", ")}.`;
}
