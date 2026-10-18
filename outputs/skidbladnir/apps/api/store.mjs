import { DatabaseSync } from 'node:sqlite';
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL)');
  }
  bind(identity) {
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    const previous=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('provider');
    const value=JSON.stringify(identity);
    if(previous && previous.value!==value)throw Error('Database belongs to another provider or AWS configuration. Use a separate database.');
    if(!previous)this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('provider',value);
  }
  terminal(id) {const r=this.db.prepare('SELECT body FROM terminals WHERE id=?').get(id);return r&&JSON.parse(r.body);}
  terminals() {return this.db.prepare('SELECT body FROM terminals ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body));}
  saveTerminal(record) {this.db.prepare('INSERT INTO terminals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,JSON.stringify(record));}
  artifact(id) {const r=this.db.prepare('SELECT body FROM artifacts WHERE id=?').get(id);return r&&JSON.parse(r.body);}
  artifacts() {return this.db.prepare('SELECT body FROM artifacts ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body));}
  saveArtifact(record) {this.db.prepare('INSERT INTO artifacts VALUES (?,?)').run(record.id,JSON.stringify(record));}
  command(id) { const r=this.db.prepare('SELECT body FROM commands WHERE id=?').get(id);return r&&JSON.parse(r.body); }
  commands() {return this.db.prepare('SELECT body FROM commands ORDER BY rowid DESC LIMIT 100').all().map(r=>JSON.parse(r.body));}
  saveCommand(command) {this.db.prepare('INSERT INTO commands VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(command.id,JSON.stringify(command));}
  list() { return this.db.prepare('SELECT body FROM workers ORDER BY rowid DESC').all().map(x=>JSON.parse(x.body)); }
  get(id) { const row = this.db.prepare('SELECT body FROM workers WHERE id = ?').get(id); return row && JSON.parse(row.body); }
  save(worker, message) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO workers VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(worker.id, JSON.stringify(worker));
      this.db.prepare('INSERT INTO events (worker_id, at, message) VALUES (?, ?, ?)').run(worker.id, new Date().toISOString(), message);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events() { return this.db.prepare('SELECT sequence, worker_id AS workerId, at, message FROM events ORDER BY sequence DESC LIMIT 200').all(); }
  close() { this.db.close(); }
}
