import { newId } from "@mimir/protocol";

/** The slice of a better-sqlite3 connection the corruption helper needs. */
export interface SqlDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  transaction<T>(fn: () => T): () => T;
}

export interface CorruptRowOptions {
  streamId?: string;
  type?: string;
  /** Stored payload text. Default: a JSON object cut off mid-string, like a torn write. */
  payload?: string;
}

/**
 * Writes an event row straight into the store's SQLite file, bypassing the store, keeping the
 * counters consistent (as a torn or tampered write that got past the store would). Use a second
 * connection to the same file.
 */
export function injectCorruptEventRow(
  db: SqlDb,
  opts: CorruptRowOptions = {},
): { id: string; globalSeq: number; sequence: number } {
  const streamId = opts.streamId ?? "chaos-corrupt";
  return db.transaction(() => {
    const globalSeq = (
      db
        .prepare("UPDATE counters SET value = value + 1 WHERE name = 'global_seq' RETURNING value")
        .get() as { value: number }
    ).value;
    const sequence = (
      db
        .prepare(
          `INSERT INTO streams (stream_id, last_sequence) VALUES (?, 1)
           ON CONFLICT (stream_id) DO UPDATE SET last_sequence = last_sequence + 1
           RETURNING last_sequence`,
        )
        .get(streamId) as { last_sequence: number }
    ).last_sequence;
    const id = newId("evt");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO events (id, stream_id, sequence, global_seq, type, provenance, source,
         occurred_at, observed_at, payload)
       VALUES (?, ?, ?, ?, ?, 'observed', 'chaos', ?, ?, ?)`,
    ).run(
      id,
      streamId,
      sequence,
      globalSeq,
      opts.type ?? "session.output",
      now,
      now,
      opts.payload ?? '{"text":"half a line, then the power went',
    );
    return { id, globalSeq, sequence };
  })();
}
