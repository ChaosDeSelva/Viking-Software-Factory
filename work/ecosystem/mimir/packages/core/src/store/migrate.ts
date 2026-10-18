import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const FILE_RE = /^(\d+)_([\w-]+)\.sql$/;

/** Reads `migrations/NNN_name.sql` files, sorted by version. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .flatMap((file) => {
      const m = FILE_RE.exec(file);
      if (!m?.[1] || !m[2]) return [];
      return [{ version: Number(m[1]), name: m[2], sql: readFileSync(join(dir, file), "utf8") }];
    })
    .sort((a, b) => a.version - b.version);
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, migrations: Migration[] = listMigrations()): number[] {
  const versions = new Set<number>();
  for (const m of migrations) {
    if (versions.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    versions.add(m.version);
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const known = Math.max(0, ...versions);
  const newest = Math.max(0, ...done);
  if (newest > known) {
    throw new Error(
      `database schema version ${newest} is newer than this build supports (${known}); upgrade Mimir`,
    );
  }
  const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  return applied;
}
