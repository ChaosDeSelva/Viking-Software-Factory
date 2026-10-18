import type { SqliteDatabase } from "./db.js";
import type { SearchHit } from "./types.js";

export interface SearchOptions {
  /** Default 10, capped at 100. */
  limit?: number;
}

/**
 * Turn arbitrary user text into a safe FTS5 query: every word becomes a quoted
 * term (implicit AND), so FTS operators in the input are treated literally.
 */
export function toFtsQuery(query: string): string | undefined {
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return undefined;
  return terms.map((t) => `"${t}"`).join(" ");
}

export function search(
  db: SqliteDatabase,
  projectId: string,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  return db
    .prepare(
      `SELECT c.id AS chunkId, c.document_id AS documentId, d.path AS path, d.kind AS kind,
              c.text AS text, c.start_line AS startLine, c.end_line AS endLine,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ? AND d.project_id = ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(fts, projectId, limit) as SearchHit[];
}
