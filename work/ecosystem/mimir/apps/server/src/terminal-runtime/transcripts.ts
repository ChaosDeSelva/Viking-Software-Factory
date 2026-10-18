// Session-log contracts informed by upstream terminal helpers (MIT, Kun Chen).
// See third_party/terminal-bridge/LICENSE. No transcript content is emitted or persisted.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type TranscriptBinding = {
  kind: "cursor" | "muse";
  root: string;
  workspace: string;
  prior: string[];
  ignored?: string;
};
const maxBytes = 8 * 1024 * 1024;
function directories(path: string): string[] {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    if (entries.length > 10000) throw Error("Transcript namespace exceeds bound");
    return entries.filter((e) => e.isDirectory()).map((e) => join(path, e.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function contents(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw Error("Unsupported transcript file");
  const data = readFileSync(path, "utf8");
  if (Buffer.byteLength(data) > maxBytes) throw Error("Transcript exceeds bound");
  return data;
}
function candidates(binding: TranscriptBinding): string[] {
  if (binding.kind === "cursor") {
    const projects = directories(binding.root).filter((project) => {
      try {
        return (
          JSON.parse(contents(join(project, ".workspace-trusted"))).workspacePath ===
          binding.workspace
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    if (projects.length > 1) throw Error("Ambiguous workspace identity");
    return projects
      .flatMap((project) => directories(join(project, "agent-transcripts")))
      .map((dir) => join(dir, basename(dir) + ".jsonl"));
  }
  let paths = [binding.root];
  for (let depth = 0; depth < 4; depth++) {
    paths = paths.flatMap(directories);
    if (paths.length > 10000) throw Error("Transcript namespace exceeds bound");
  }
  return paths
    .map((dir) => join(dir, "session.jsonl"))
    .filter((file) => {
      const first = contents(file).split("\n", 1)[0];
      return first && JSON.parse(first)?.payload?.record?.workspace_root === binding.workspace;
    });
}
export function bindTranscript(
  kind: string,
  workspace: string,
  env: Record<string, string>,
): TranscriptBinding | undefined {
  if (kind !== "cursor" && kind !== "muse") return undefined;
  const home = env.HOME ?? homedir();
  const root =
    kind === "cursor"
      ? (env.MIMIR_CURSOR_PROJECTS_ROOT ?? join(home, ".cursor", "projects"))
      : (env.MIMIR_MUSE_SESSIONS_ROOT ??
        join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "muse", "sessions"));
  const binding: TranscriptBinding = { kind, root, workspace, prior: [] };
  // Fail launch if the baseline cannot be established; never bind an old session.
  binding.prior = candidates(binding);
  return binding;
}
export function foldTranscript(
  kind: "cursor" | "muse",
  text: string,
): "running" | "waiting" | undefined {
  if (!text.endsWith("\n")) return undefined;
  let seen = false;
  let cursorOpen = false;
  const runs = new Set<string>();
  try {
    for (const line of text.split("\n").filter((line) => line.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
      if (kind === "cursor") {
        if (row.role === "user") {
          seen = true;
          cursorOpen = true;
        } else if (row.type === "turn_ended") {
          if (!seen) return undefined;
          cursorOpen = false;
        }
      } else if (row.payload?.kind === "run") {
        const { run_id: id, event } = row.payload;
        if (typeof id !== "string" || !id || !event) return undefined;
        if (event.kind === "started") {
          seen = true;
          runs.add(id);
        } else if (event.kind === "terminal") {
          if (!runs.has(id)) return undefined;
          runs.delete(id);
        }
      }
    }
    return seen ? (cursorOpen || runs.size > 0 ? "running" : "waiting") : undefined;
  } catch {
    return undefined;
  }
}
export function observeTranscript(
  binding: TranscriptBinding,
): { state: "running" | "waiting"; fingerprint: string } | undefined {
  try {
    const fresh = candidates(binding).filter((file) => !binding.prior.includes(file));
    if (fresh.length !== 1) return undefined;
    const file = fresh[0]!;
    const text = contents(file);
    const boundaries = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .flatMap((row) =>
        binding.kind === "cursor"
          ? row?.role === "user"
            ? ["open"]
            : row?.type === "turn_ended"
              ? ["close"]
              : []
          : row?.payload?.kind === "run" &&
              ["started", "terminal"].includes(row.payload.event?.kind)
            ? [JSON.stringify([row.payload.run_id, row.payload.event.kind])]
            : [],
      );
    const fingerprint = createHash("sha256")
      .update(file)
      .update("\0")
      .update(JSON.stringify(boundaries))
      .digest("hex");
    if (fingerprint === binding.ignored) return undefined;
    const state = foldTranscript(binding.kind, text);
    return state ? { state, fingerprint } : undefined;
  } catch {
    return undefined;
  }
}
