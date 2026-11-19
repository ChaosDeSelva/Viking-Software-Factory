import { createHash } from "node:crypto";
import type { EventStore } from "@mimir/core";
import {
  DecisionLogBlockRequestSchema,
  MimirError,
  type DecisionLogBlockRequest,
  type DecisionLogEntry,
  type ProjectId,
} from "@mimir/protocol";

export const MAX_DECISION_LOG_BLOCK_BYTES = 256 * 1024;
const MAX_CACHED_BLOCKS = 32;

function digestOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class DecisionLogStore {
  private readonly insert;
  private readonly select;
  private decoded = new Map<string, DecisionLogBlockRequest>();

  constructor(store: EventStore) {
    const db = store.connection();
    db.exec(`CREATE TABLE IF NOT EXISTS project_decision_log_blocks (
      project_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (project_id, digest)
    ) WITHOUT ROWID`);
    this.select = db.prepare<[string, string], { body: string }>(
      "SELECT body FROM project_decision_log_blocks WHERE project_id = ? AND digest = ?",
    );
    this.insert = db.prepare(
      "INSERT INTO project_decision_log_blocks (project_id, digest, body) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );
  }

  put(projectId: ProjectId, block: DecisionLogBlockRequest): string {
    const body = JSON.stringify({
      previous: block.previous,
      entries: block.entries.map(({ id, markdown }) => ({ id, markdown })),
    });
    if (Buffer.byteLength(body) > MAX_DECISION_LOG_BLOCK_BYTES) {
      throw new MimirError("validation_failed", "Decision log block exceeds 256 KiB.", {
        maxBytes: MAX_DECISION_LOG_BLOCK_BYTES,
      });
    }
    if (block.previous !== null) this.requireBlock(projectId, block.previous);
    const digest = digestOf(body);
    if (this.insert.run(projectId, digest, body).changes === 0)
      this.requireBlock(projectId, digest);
    return digest;
  }

  requireBlock(projectId: ProjectId, digest: string): DecisionLogBlockRequest {
    const row = this.select.get(projectId, digest);
    if (!row) {
      throw new MimirError(
        "not_found",
        `Decision log block ${digest} is missing for project ${projectId}.`,
      );
    }
    const corrupt = () =>
      new MimirError(
        "internal",
        `Decision log block ${digest} is corrupt for project ${projectId}.`,
      );
    // A decoded cache hit must never hide corruption in the stored bytes.
    if (digestOf(row.body) !== digest) throw corrupt();
    const cached = this.decoded.get(digest);
    if (cached) return cached;
    let block: DecisionLogBlockRequest;
    try {
      block = DecisionLogBlockRequestSchema.parse(JSON.parse(row.body));
    } catch {
      throw corrupt();
    }
    return block;
  }

  entries(projectId: ProjectId, head: string): DecisionLogEntry[] {
    const chunks: DecisionLogEntry[][] = [];
    // Keep the newest blocks warm even when traversing a journal larger than the cache.
    const recent = new Map<string, DecisionLogBlockRequest>();
    let digest: string | null = head;
    while (digest !== null) {
      const block = this.requireBlock(projectId, digest);
      if (recent.size < MAX_CACHED_BLOCKS) recent.set(digest, block);
      chunks.push(block.entries);
      digest = block.previous;
    }
    this.decoded = recent;
    const entries: DecisionLogEntry[] = [];
    for (const chunk of chunks.reverse()) {
      for (const entry of chunk) {
        // Consecutive fragments share an ID when one decision exceeds the block limit.
        const last = entries.at(-1);
        if (last?.id === entry.id) last.markdown += entry.markdown;
        else entries.push({ ...entry });
      }
    }
    return entries;
  }
}
