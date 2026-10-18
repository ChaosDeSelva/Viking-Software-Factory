import { createHash } from "node:crypto";
import { MimirError, newId, type CommandStatus } from "@mimir/protocol";
import { redactPayload, type PayloadRedactor } from "../redaction.js";
import type { Db, Stmt } from "./db.js";
import { assertJsonDepth } from "../json-depth.js";

export interface CommandRecord {
  id: string;
  idempotencyKey: string;
  kind: string;
  status: CommandStatus;
  requestHash: string;
  /** The request as stored (after redaction). */
  request: unknown;
  response: unknown;
  error: unknown;
  createdAt: string;
  updatedAt: string;
}

export type BeginResult = { replay: CommandRecord } | { fresh: CommandRecord };

interface CommandRow {
  id: string;
  idempotency_key: string;
  kind: string;
  status: string;
  request_hash: string;
  request: string;
  response: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "rejected"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** sha256 over the command kind and the key-order-independent JSON of the request. */
export function hashRequest(kind: string, request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, canonical(request) ?? null]))
    .digest("hex");
}

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

function rowToRecord(row: CommandRow): CommandRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    status: row.status as CommandStatus,
    requestHash: row.request_hash,
    request: parse(row.request),
    response: parse(row.response),
    error: parse(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Idempotency ledger for mutating commands, keyed by the client's idempotency key.
 *
 * Stored request, response and error pass through the payload redactor, so a replay returns
 * the *redacted* response: a command whose response legitimately contains a secret-shaped value
 * (e.g. a minted credential) cannot be replayed verbatim. The request hash is computed on the
 * raw request, so replay matching is unaffected.
 *
 * Boot recovery: commands interrupted by a crash stay `accepted`/`running` and would replay as
 * in flight forever. The server must, on boot and before accepting requests, call
 * `listInFlight()` and resolve each one (re-drive it, or `markInterrupted(id)`).
 */
export class CommandLedger {
  private readonly db: Db;
  private readonly redactor: PayloadRedactor;
  private readonly byKey: Stmt;
  private readonly byId: Stmt;
  private readonly insert: Stmt;
  private readonly finish: Stmt;
  private readonly inFlight: Stmt;

  constructor(db: Db, redactor: PayloadRedactor = (v) => redactPayload(v)) {
    this.db = db;
    this.redactor = redactor;
    this.byKey = db.prepare("SELECT * FROM commands WHERE idempotency_key = ?");
    this.byId = db.prepare("SELECT * FROM commands WHERE id = ?");
    this.insert = db.prepare(
      `INSERT INTO commands (id, idempotency_key, kind, status, request_hash, request, created_at, updated_at)
       VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)`,
    );
    this.inFlight = db.prepare(
      "SELECT * FROM commands WHERE status IN ('accepted', 'running') ORDER BY created_at, id",
    );
    this.finish = db.prepare(
      "UPDATE commands SET status = ?, response = ?, error = ?, updated_at = ? WHERE id = ?",
    );
  }

  /**
   * Records a new command, or returns the existing one for a repeated key with an identical
   * request. A repeated key with a different request throws `idempotency_replay_mismatch`.
   */
  begin(idempotencyKey: string, kind: string, request: unknown): BeginResult {
    // Bound depth first: hashing and redaction below walk the request recursively.
    assertJsonDepth(request, "command request");
    const requestHash = hashRequest(kind, request);
    return this.db
      .transaction((): BeginResult => {
        const existing = this.byKey.get(idempotencyKey) as CommandRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new MimirError(
              "idempotency_replay_mismatch",
              "idempotency key was already used with a different request",
              { idempotencyKey, commandId: existing.id },
            );
          }
          return { replay: rowToRecord(existing) };
        }
        const id = newId("cmd");
        const now = new Date().toISOString();
        const stored = JSON.stringify(this.redactor(request) ?? null);
        this.insert.run(id, idempotencyKey, kind, requestHash, stored, now, now);
        return { fresh: rowToRecord(this.byId.get(id) as CommandRow) };
      })
      .immediate();
  }

  succeed(id: string, response: unknown): CommandRecord {
    return this.complete(id, "succeeded", response, null);
  }

  fail(id: string, error: unknown): CommandRecord {
    return this.complete(id, "failed", null, error);
  }

  /** Commands that were begun but never finished (status `accepted` or `running`), oldest first. */
  listInFlight(): CommandRecord[] {
    return (this.inFlight.all() as CommandRow[]).map(rowToRecord);
  }

  /**
   * Fails an unfinished command left over from a previous process, with error
   * `{code: 'internal', message, interrupted: true}`. Replays of its key then return this record.
   */
  markInterrupted(id: string): CommandRecord {
    return this.complete(id, "failed", null, {
      code: "internal",
      message: "command interrupted by a server restart",
      interrupted: true,
    });
  }

  get(id: string): CommandRecord | undefined {
    const row = this.byId.get(id) as CommandRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByKey(idempotencyKey: string): CommandRecord | undefined {
    const row = this.byKey.get(idempotencyKey) as CommandRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private complete(
    id: string,
    status: "succeeded" | "failed",
    response: unknown,
    error: unknown,
  ): CommandRecord {
    return this.db
      .transaction(() => {
        const row = this.byId.get(id) as CommandRow | undefined;
        if (!row) throw new MimirError("not_found", `command ${id} not found`, { id });
        if (TERMINAL.has(row.status)) {
          throw new MimirError("invalid_transition", `command ${id} is already ${row.status}`, {
            id,
            from: row.status,
            to: status,
          });
        }
        const json = (v: unknown) => (v === null ? null : JSON.stringify(this.redactor(v) ?? null));
        this.finish.run(status, json(response), json(error), new Date().toISOString(), id);
        return rowToRecord(this.byId.get(id) as CommandRow);
      })
      .immediate();
  }
}
