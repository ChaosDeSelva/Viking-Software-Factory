import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactIdSchema, newId } from "@mimir/protocol";

export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StoredArtifact {
  id: string;
  path: string;
  uri: string;
  /** `sha256:<hex>` */
  hash: string;
  bytes: number;
}

/**
 * Content-addressed-by-id artifact files under one directory (`MIMIR_DATA_DIR/artifacts/<id>`).
 * Files are written atomically with mode 0600. Metadata lives in `artifact.recorded` events.
 */
export class ArtifactStore {
  constructor(readonly dir: string) {}

  write(content: string | Buffer): StoredArtifact {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const id = newId("art");
    const path = join(this.dir, id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
    return {
      id,
      path,
      uri: pathToFileURL(path).href,
      hash: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      bytes: data.length,
    };
  }

  /** The stored bytes, or null for an unknown, pruned or malformed id. */
  read(id: string): Buffer | null {
    if (!ArtifactIdSchema.safeParse(id).success) return null;
    try {
      return readFileSync(join(this.dir, id));
    } catch {
      return null;
    }
  }

  /**
   * Locates an artifact file for streaming, confined to this store's directory: a malformed id,
   * a missing file, a symlink or anything resolving outside the directory is null.
   */
  locate(id: string): { path: string; bytes: number } | null {
    if (!ArtifactIdSchema.safeParse(id).success) return null;
    const path = join(this.dir, id);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return null; // symlinks and anything else are refused
      if (dirname(realpathSync(path)) !== realpathSync(this.dir)) return null;
      return { path, bytes: st.size };
    } catch {
      return null;
    }
  }

  /** Deletes artifact files last modified more than `retentionDays` before `now`. */
  prune(now: Date, retentionDays: number = DEFAULT_ARTIFACT_RETENTION_DAYS): string[] {
    const cutoff = now.getTime() - retentionDays * DAY_MS;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names.sort()) {
      if (!ArtifactIdSchema.safeParse(name).success) continue;
      const path = join(this.dir, name);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed.push(name);
      }
    }
    return removed;
  }
}
