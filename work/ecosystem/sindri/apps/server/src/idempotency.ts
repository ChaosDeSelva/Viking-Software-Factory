import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@sindri/knowledge";
import { ApiError } from "./errors.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}

export const hashRequest = (method: string, url: string, body: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([method, url, canonical(body) ?? null]))
    .digest("hex");

/**
 * The stored key of a request whose receipt must not identify what it acted on (project
 * purge, review I3): only a hash of the Idempotency-Key is kept.
 */
export const receiptKey = (key: string) =>
  `sha256:${createHash("sha256").update(key).digest("hex")}`;

/** What a redacted receipt replays: the status only, no ids. */
export const REDACTED_RECEIPT_BODY = JSON.stringify({ replayed: true });

export interface StoredResponse {
  statusCode: number;
  contentType: string | null;
  body: string;
}

interface Row {
  request_hash: string;
  state: "pending" | "done";
  status_code: number | null;
  content_type: string | null;
  response: string | null;
}

/** The `commands` table: one row per Idempotency-Key. */
export class CommandStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date,
  ) {}

  /** Returns a stored response to replay, or `null` after reserving the key for this request. */
  begin(key: string, method: string, url: string, body: unknown): StoredResponse | null {
    const hash = hashRequest(method, url, body);
    return this.db
      .transaction((): StoredResponse | null => {
        const row = this.db
          .prepare(
            "SELECT request_hash, state, status_code, content_type, response FROM commands WHERE idempotency_key = ?",
          )
          .get(key) as Row | undefined;
        if (row) {
          if (row.request_hash !== hash)
            throw new ApiError(
              409,
              "idempotency_mismatch",
              "Idempotency-Key was already used with a different request",
            );
          if (row.state === "pending")
            throw new ApiError(
              409,
              "idempotency_in_progress",
              "a request with this key is in progress",
            );
          return {
            statusCode: row.status_code ?? 200,
            contentType: row.content_type,
            body: row.response ?? "",
          };
        }
        this.db
          .prepare(
            "INSERT INTO commands (idempotency_key, request_hash, method, url, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
          )
          .run(key, hash, method, url, this.now().toISOString());
        return null;
      })
      .immediate();
  }

  complete(key: string, res: StoredResponse, projectId: string | null = null): void {
    this.db
      .prepare(
        "UPDATE commands SET state = 'done', status_code = ?, content_type = ?, response = ?, project_id = ?, completed_at = ? WHERE idempotency_key = ?",
      )
      .run(res.statusCode, res.contentType, res.body, projectId, this.now().toISOString(), key);
  }

  /**
   * Forget every stored command of a project: rows tagged with it, and any row whose URL or
   * stored response mentions its id. `exceptKey` keeps the purge request's own reservation.
   */
  purgeProject(projectId: string, exceptKey: string | null = null): number {
    return this.db
      .prepare(
        `DELETE FROM commands WHERE idempotency_key IS NOT ? AND (project_id = ?
           OR instr(url, ?) > 0 OR instr(coalesce(response, ''), ?) > 0)`,
      )
      .run(exceptKey, projectId, projectId, projectId).changes;
  }

  /** Drop reservations left by a crash between begin and complete (call at startup). */
  clearPending(): number {
    return this.db.prepare("DELETE FROM commands WHERE state = 'pending'").run().changes;
  }

  /** Forget a reservation (5xx outcomes are retryable). */
  release(key: string): void {
    this.db
      .prepare("DELETE FROM commands WHERE idempotency_key = ? AND state = 'pending'")
      .run(key);
  }
}
