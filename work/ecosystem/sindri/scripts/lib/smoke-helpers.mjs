// Small helpers for scripts/qa-smoke.mjs. Node built-ins only (node:sqlite reads the database).
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

/** Plain text of an Atlassian document (Jira description): one line per block, `- ` for list items. */
export function adfText(doc) {
  if (!doc || typeof doc !== "object") return "";
  const lines = [];
  const inline = (n) =>
    n.type === "text" ? (n.text ?? "") : (n.content ?? []).map(inline).join("");
  const walk = (n, bullet) => {
    if (n.type === "paragraph" || n.type === "heading") lines.push(`${bullet}${inline(n)}`);
    else if (n.type === "listItem") (n.content ?? []).forEach((c) => walk(c, "- "));
    else (n.content ?? []).forEach((c) => walk(c, bullet));
  };
  walk(doc, "");
  return lines.join("\n");
}

/** A loopback TCP port that was free a moment ago. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const quoteId = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * `{ table: count }` of rows in which any column's text contains `id` (tables with zero
 * matches are omitted). `exclude[table] = { column, values }` drops rows whose column is in values.
 */
export function rowsMentioning(file, id, { exclude = {} } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const out = {};
    for (const table of tables) {
      const cols = db
        .prepare(`PRAGMA table_info(${quoteId(table)})`)
        .all()
        .map((c) => c.name);
      if (cols.length === 0) continue;
      const where = cols.map((c) => `instr(CAST(${quoteId(c)} AS TEXT), ?) > 0`).join(" OR ");
      const params = cols.map(() => id);
      let sql = `SELECT COUNT(*) AS n FROM ${quoteId(table)} WHERE (${where})`;
      const ex = exclude[table];
      if (ex && ex.values.length) {
        sql += ` AND ${quoteId(ex.column)} NOT IN (${ex.values.map(() => "?").join(",")})`;
        params.push(...ex.values);
      }
      const { n } = db.prepare(sql).get(...params);
      if (n > 0) out[table] = n;
    }
    return out;
  } finally {
    db.close();
  }
}
