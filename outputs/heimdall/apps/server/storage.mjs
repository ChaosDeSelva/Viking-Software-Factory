import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "heimdall.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, json TEXT); CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, revision TEXT, json TEXT, seen INTEGER DEFAULT 0, active INTEGER DEFAULT 1, at TEXT); CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, cursor TEXT); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, id TEXT, json TEXT, UNIQUE(source,id)); CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, hash TEXT, status INTEGER, json TEXT); CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, at TEXT, json TEXT);`,
    );
  }
  cursor(source) {
    return this.db
      .prepare("SELECT cursor FROM cursors WHERE source=?")
      .get(source)?.cursor;
  }
  setCursor(source, cursor) {
    this.db
      .prepare("INSERT OR REPLACE INTO cursors VALUES (?,?)")
      .run(source, cursor);
  }
  event(source, event, cursor) {
    this.db.exec("BEGIN");
    try {
      const result = this.db
        .prepare("INSERT OR IGNORE INTO events(source,id,json) VALUES (?,?,?)")
        .run(source, event.eventId, JSON.stringify(event));
      if (cursor) this.setCursor(source, cursor);
      this.db
        .prepare(
          "DELETE FROM events WHERE seq <= (SELECT MAX(seq)-20000 FROM events)",
        )
        .run();
      this.db.exec("COMMIT");
      return result.changes > 0;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  events({
    before = Number.MAX_SAFE_INTEGER,
    search = "",
    taskId = "",
    source = "",
    type = "",
    missionId = "",
    limit = 150,
  } = {}) {
    return this.db
      .prepare(
        "SELECT seq,json FROM events WHERE seq < ? AND json LIKE ? AND json LIKE ? AND (? = '' OR source = ? OR source LIKE ?) AND (? = '' OR json_extract(json,'$.type') LIKE ?) AND (? = '' OR json_extract(json,'$.missionId') = ? OR json_extract(json,'$.payload.missionId') = ?) ORDER BY seq DESC LIMIT ?",
      )
      .all(
        Number(before),
        "%" + search + "%",
        "%" + taskId + "%",
        source,
        source,
        source + ":%",
        type,
        type + ".%",
        missionId,
        missionId,
        missionId,
        Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 150)),
      )
      .map((r) => ({ ...JSON.parse(r.json), cacheSequence: r.seq }));
  }
  receipt(key) {
    return this.db.prepare("SELECT * FROM commands WHERE key=?").get(key);
  }
  receiptPut(key, hash, status, json) {
    this.db
      .prepare("INSERT OR REPLACE INTO commands VALUES (?,?,?,?)")
      .run(key, hash, status, JSON.stringify(json));
  }
  audit(data) {
    this.db
      .prepare("INSERT INTO audit(at,json) VALUES (?,?)")
      .run(new Date().toISOString(), JSON.stringify(data));
  }
  audits() {
    return this.db
      .prepare("SELECT at,json FROM audit ORDER BY seq DESC LIMIT 100")
      .all()
      .map((r) => ({ at: r.at, ...JSON.parse(r.json) }));
  }
  preferences() {
    const row = this.db
      .prepare("SELECT json FROM preferences WHERE key='ui'")
      .get();
    return row ? JSON.parse(row.json) : {};
  }
  savePreferences(value) {
    this.db
      .prepare("INSERT OR REPLACE INTO preferences VALUES ('ui',?)")
      .run(JSON.stringify(value));
  }
  updateNotifications(records) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE notifications SET active=0 WHERE active=1").run();
      const put = this.db.prepare(
        `INSERT INTO notifications(id,revision,json,seen,active,at) VALUES (?,?,?,0,1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,active=1,seen=CASE WHEN notifications.revision=excluded.revision THEN notifications.seen ELSE 0 END,at=CASE WHEN notifications.revision=excluded.revision THEN notifications.at ELSE excluded.at END,revision=excluded.revision`,
      );
      for (const r of records)
        put.run(r.id, r.revision, JSON.stringify(r), new Date().toISOString());
      this.db
        .prepare(
          "DELETE FROM notifications WHERE id IN (SELECT id FROM notifications ORDER BY at DESC LIMIT -1 OFFSET 1000)",
        )
        .run();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  notifications() {
    return this.db
      .prepare(
        "SELECT json,seen,active,at FROM notifications ORDER BY at DESC LIMIT 200",
      )
      .all()
      .map((r) => ({
        ...JSON.parse(r.json),
        seen: !!r.seen,
        active: !!r.active,
        at: r.at,
      }));
  }
  markNotification(id) {
    if (id === "all") this.db.prepare("UPDATE notifications SET seen=1").run();
    else this.db.prepare("UPDATE notifications SET seen=1 WHERE id=?").run(id);
  }
  clearSource(source) {
    this.db
      .prepare("DELETE FROM events WHERE source=? OR source LIKE ?")
      .run(source, source + ":%");
    this.db
      .prepare("DELETE FROM cursors WHERE source=? OR source LIKE ?")
      .run(source, source + ":%");
  }
  close() {
    this.db.close();
  }
}
