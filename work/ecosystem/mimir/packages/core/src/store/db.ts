import Database from "better-sqlite3";

export type Db = Database.Database;

/** Opens a SQLite connection with Mimir's required pragmas (WAL, FKs on, 5s busy timeout). */
export function openDatabase(path: string, options: { readOnly?: boolean } = {}): Db {
  if (options.readOnly) {
    const ro = new Database(path, { readonly: true, fileMustExist: true });
    ro.pragma("busy_timeout = 5000");
    return ro;
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** A prepared statement with loosely typed bind parameters. */
export type Stmt = Database.Statement<unknown[]>;
