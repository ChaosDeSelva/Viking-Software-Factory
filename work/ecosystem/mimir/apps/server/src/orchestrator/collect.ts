import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { redact } from "@mimir/core";
import type { ArtifactKind } from "@mimir/protocol";
import { SERVER_SOURCE, type EmitInput } from "../emit.js";
import type { StoredArtifact } from "./artifacts.js";

/** Where an agent leaves files for Mimir to record, relative to its worktree. */
export const ARTIFACT_COLLECTION_DIR = ".mimir/artifacts";

export interface CollectLimits {
  /** Per file; larger files are skipped (`file_too_large`). */
  maxFileBytes: number;
  /** Sum of recorded files; a file that would exceed it is skipped (`total_too_large`). */
  maxTotalBytes: number;
  /** Directory entries considered (by name); the rest are reported as truncated. */
  maxFiles: number;
}

export const DEFAULT_COLLECT_LIMITS: CollectLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 200,
};

export type CollectSkipReason =
  | "symlink"
  | "not_a_file"
  | "file_too_large"
  | "total_too_large"
  | "unreadable"
  | "outside_worktree";

export interface CollectedFile {
  name: string;
  kind: ArtifactKind;
  content: Buffer;
}

export interface CollectSkip {
  name: string;
  reason: CollectSkipReason;
  bytes?: number;
  limitBytes?: number;
}

export interface CollectionResult {
  files: CollectedFile[];
  skipped: CollectSkip[];
  truncated: { found: number; kept: number; limit: number } | null;
}

/** `review.json` → review, `screenshot-*.png` → screenshot, `*.log` → test.output, else file. */
export function artifactKindForFile(name: string): ArtifactKind {
  if (name === "review.json") return "review";
  if (name.startsWith("screenshot-") && name.endsWith(".png")) return "screenshot";
  if (name.endsWith(".log")) return "test.output";
  return "file";
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep);
};

/**
 * Reads at most `limit + 1` bytes of a regular file without following symlinks or blocking on
 * FIFOs, and checks the opened file is the one `lstat` saw (no swap between the two).
 */
function readRegular(path: string, seen: Stats, limit: number): Buffer | CollectSkipReason {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "unreadable";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== seen.ino || st.dev !== seen.dev) return "not_a_file";
    const size = Math.min(st.size, limit + 1);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}

/**
 * Collects the files an agent left under `<worktree>/.mimir/artifacts/` (top level only). Every
 * entry is `lstat`ed: symlinks (also a symlinked `.mimir` or `artifacts` directory), directories,
 * FIFOs and devices are skipped, never followed or read. Bounded by `limits`.
 */
export function collectArtifactFiles(
  worktreePath: string,
  limits: CollectLimits = DEFAULT_COLLECT_LIMITS,
): CollectionResult {
  const result: CollectionResult = { files: [], skipped: [], truncated: null };
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return result;
  }
  // Each directory level must be a real directory inside the worktree.
  let dir = root;
  for (const part of [".mimir", "artifacts"]) {
    dir = join(dir, part);
    const name = relative(root, dir).split(sep).join("/");
    let st: Stats;
    try {
      st = lstatSync(dir);
    } catch {
      return result; // nothing to collect
    }
    if (st.isSymbolicLink()) return { ...result, skipped: [{ name, reason: "symlink" }] };
    if (!st.isDirectory()) return { ...result, skipped: [{ name, reason: "not_a_file" }] };
  }
  try {
    if (!within(root, realpathSync(dir))) {
      return {
        ...result,
        skipped: [{ name: ARTIFACT_COLLECTION_DIR, reason: "outside_worktree" }],
      };
    }
  } catch {
    return result;
  }

  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return { ...result, skipped: [{ name: ARTIFACT_COLLECTION_DIR, reason: "unreadable" }] };
  }
  if (names.length > limits.maxFiles) {
    result.truncated = { found: names.length, kept: limits.maxFiles, limit: limits.maxFiles };
    names = names.slice(0, limits.maxFiles);
  }

  let total = 0;
  for (const name of names) {
    const path = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      result.skipped.push({ name, reason: "unreadable" });
      continue;
    }
    if (st.isSymbolicLink()) {
      result.skipped.push({ name, reason: "symlink" });
      continue;
    }
    if (!st.isFile()) {
      result.skipped.push({ name, reason: "not_a_file" });
      continue;
    }
    if (st.size > limits.maxFileBytes) {
      result.skipped.push({
        name,
        reason: "file_too_large",
        bytes: st.size,
        limitBytes: limits.maxFileBytes,
      });
      continue;
    }
    if (total + st.size > limits.maxTotalBytes) {
      result.skipped.push({
        name,
        reason: "total_too_large",
        bytes: st.size,
        limitBytes: limits.maxTotalBytes,
      });
      continue;
    }
    const content = readRegular(path, st, limits.maxFileBytes);
    if (typeof content === "string") {
      result.skipped.push({ name, reason: content });
      continue;
    }
    if (content.length > limits.maxFileBytes) {
      // grew after lstat
      result.skipped.push({
        name,
        reason: "file_too_large",
        bytes: content.length,
        limitBytes: limits.maxFileBytes,
      });
      continue;
    }
    total += content.length;
    result.files.push({ name, kind: artifactKindForFile(name), content });
  }
  return result;
}

export type CollectedEmit = EmitInput<
  "artifact.recorded" | "artifact.collection_skipped" | "artifact.collection_truncated"
>;

export interface RecordCollectionDeps {
  task: { id: string; missionId: string };
  write(content: Buffer): StoredArtifact;
  emit(input: CollectedEmit): void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text is redacted before it is stored; binary content (not valid UTF-8, or PNG) is stored as is. */
function redactedContent(file: CollectedFile): Buffer {
  if (file.kind === "screenshot") return file.content;
  let text: string;
  try {
    text = utf8.decode(file.content);
  } catch {
    return file.content;
  }
  const r = redact(text);
  return r.redacted ? Buffer.from(r.text, "utf8") : file.content;
}

/**
 * Stores each collected file and emits `artifact.recorded` (provenance `observed`: Mimir read
 * the bytes itself), then one `artifact.collection_skipped` per skipped entry and at most one
 * `artifact.collection_truncated`.
 */
export function recordCollection(result: CollectionResult, deps: RecordCollectionDeps): void {
  const { task } = deps;
  const base = {
    streamId: `task:${task.id}`,
    taskId: task.id,
    missionId: task.missionId,
    provenance: "observed" as const,
    source: SERVER_SOURCE,
  };
  for (const file of result.files) {
    const a = deps.write(redactedContent(file));
    deps.emit({
      ...base,
      type: "artifact.recorded",
      payload: {
        artifactId: a.id as never,
        taskId: task.id as never,
        kind: file.kind,
        uri: a.uri,
        hash: a.hash,
        bytes: a.bytes,
        name: file.name,
      },
    });
  }
  for (const s of result.skipped) {
    deps.emit({
      ...base,
      type: "artifact.collection_skipped",
      payload: { taskId: task.id as never, ...s },
    });
  }
  if (result.truncated) {
    deps.emit({
      ...base,
      type: "artifact.collection_truncated",
      payload: { taskId: task.id as never, ...result.truncated },
    });
  }
}
