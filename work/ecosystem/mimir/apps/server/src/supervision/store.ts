import type { SupervisorPolicy, StoredPolicy } from "./policy.js";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MimirError } from "@mimir/protocol";
export type Actor = {
  id: string;
  parent: string | null;
  state: string;
  reason: string | null;
  owner: string | null;
  epoch: number;
  expires: number;
  updated: number;
};
export type Message = {
  id: string;
  actor: string;
  kind: string;
  body: string;
  state: string;
  result: string | null;
  created: number;
};
export type Lease = { actor: string; owner: string; epoch: number };
/** SQLite transactions fence stale supervisors. Inbox records survive process restarts.
 * Dispatching messages become uncertain after takeover: never blindly replay input/stop.
 */
export class SupervisorStore {
  private db: DatabaseSync;
  private inTransaction = false;
  constructor(
    file: string,
    private readonly now = () => Date.now(),
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY,parent TEXT REFERENCES actors(id),state TEXT NOT NULL DEFAULT 'ready',reason TEXT,owner TEXT,epoch INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id),kind TEXT NOT NULL,body TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS policies(actor TEXT PRIMARY KEY REFERENCES actors(id),body TEXT NOT NULL,turns INTEGER NOT NULL DEFAULT 0,lastQueued INTEGER NOT NULL DEFAULT 0);
      PRAGMA foreign_keys=ON;`);
  }
  private transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  private record(actor: string, kind: string, body: unknown) {
    this.db
      .prepare("INSERT INTO observations(actor,kind,body,created) VALUES(?,?,?,?)")
      .run(actor, kind, JSON.stringify(body), this.now());
  }
  register(id: string, parent: string | null = null) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === parent)
      throw new MimirError("validation_failed", "Invalid supervisor identity");
    this.transaction(() => {
      const prior = this.get(id);
      if (prior) {
        if (prior.parent !== parent)
          throw new MimirError("conflict", "Supervisor parent cannot change");
        return;
      }
      if (parent && !this.get(parent))
        throw new MimirError("not_found", "Parent supervisor not found");
      this.db
        .prepare("INSERT INTO actors(id,parent,updated) VALUES(?,?,?)")
        .run(id, parent, this.now());
      this.record(id, "registered", { parent });
    });
    return this.get(id)!;
  }
  get(id: string) {
    return this.db.prepare("SELECT * FROM actors WHERE id=?").get(id) as Actor | undefined;
  }
  list() {
    return this.db.prepare("SELECT * FROM actors ORDER BY id").all() as Actor[];
  }
  acquire(actor: string, owner: string, ttl = 10000): Lease | null {
    if (!owner || !Number.isInteger(ttl) || ttl < 100 || ttl > 60000)
      throw new Error("Invalid lease");
    return this.transaction(() => {
      const row = this.get(actor);
      if (!row) throw new MimirError("not_found", "Supervisor not found");
      if (row.owner && row.expires > this.now() && row.owner !== owner) return null;
      const takeover = row.owner !== owner || row.expires <= this.now();
      const epoch = row.epoch + (takeover ? 1 : 0);
      this.db
        .prepare("UPDATE actors SET owner=?,epoch=?,expires=?,updated=? WHERE id=?")
        .run(owner, epoch, this.now() + ttl, this.now(), actor);
      if (takeover) {
        this.db
          .prepare(
            "UPDATE inbox SET state='uncertain',result='Supervisor lease expired during dispatch; inspect the session before resolving' WHERE actor=? AND state='dispatching'",
          )
          .run(actor);
        this.record(actor, "lease_acquired", { owner, epoch });
      }
      return { actor, owner, epoch };
    });
  }
  private fence(lease: Lease) {
    const row = this.get(lease.actor);
    if (!row || row.owner !== lease.owner || row.epoch !== lease.epoch || row.expires <= this.now())
      throw new MimirError("conflict", "Supervisor lease expired or ownership changed");
  }
  canDispatch(id: string): boolean {
    let actor = this.get(id);
    while (actor) {
      if (actor.state !== "ready") return false;
      if (!actor.parent) return true;
      actor = this.get(actor.parent);
    }
    return false;
  }
  fenced<T>(lease: Lease, fn: () => T): T {
    return this.transaction(() => {
      this.fence(lease);
      return fn();
    });
  }
  enqueue(id: string, actor: string, kind: string, body: unknown, approval = false) {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > 65536)
      throw new MimirError("validation_failed", "Supervisor message exceeds 64 KiB");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(approval ? [actor, kind, body, true] : [actor, kind, body]))
      .digest("hex");
    this.transaction(() => {
      if (!this.get(actor)) throw new MimirError("not_found", "Supervisor not found");
      const prior = this.db.prepare("SELECT fingerprint FROM inbox WHERE id=?").get(id);
      if (prior) {
        if (prior["fingerprint"] !== fingerprint)
          throw new MimirError("idempotency_replay_mismatch", "Supervisor message changed");
        return;
      }
      this.db
        .prepare(
          "INSERT INTO inbox(id,actor,kind,body,fingerprint,created,state) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          actor,
          kind,
          text,
          fingerprint,
          this.now(),
          approval ? "awaiting_approval" : "pending",
        );
      this.record(actor, "message_received", { id, kind });
    });
    return this.db
      .prepare("SELECT id,actor,kind,body,state,result,created FROM inbox WHERE id=?")
      .get(id) as Message;
  }
  claim(lease: Lease): Message | null {
    return this.transaction(() => {
      this.fence(lease);
      const actor = this.get(lease.actor)!;
      if (actor.state !== "ready") return null;
      let parent = actor.parent;
      while (parent) {
        const ancestor = this.get(parent);
        if (!ancestor || ancestor.state !== "ready") return null;
        parent = ancestor.parent;
      }
      const row = this.db
        .prepare(
          "SELECT * FROM inbox WHERE actor=? AND state='pending' ORDER BY created,id LIMIT 1",
        )
        .get(lease.actor) as Message | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE inbox SET state='dispatching' WHERE id=?").run(row.id);
      this.record(lease.actor, "dispatch_started", { id: row.id, epoch: lease.epoch });
      return { ...row, state: "dispatching" };
    });
  }
  finish(lease: Lease, id: string, state: "done" | "failed" | "uncertain", result: string) {
    this.transaction(() => {
      this.fence(lease);
      const update = this.db
        .prepare("UPDATE inbox SET state=?,result=? WHERE id=? AND actor=? AND state='dispatching'")
        .run(state, result.slice(0, 8192), id, lease.actor);
      if (!update.changes)
        throw new MimirError("conflict", "Message is not dispatching under this supervisor");
      this.record(lease.actor, `message_${state}`, { id, result: result.slice(0, 8192) });
    });
  }
  setState(
    id: string,
    state: "ready" | "held" | "waiting_external" | "blocked",
    reason: string | null,
  ) {
    this.transaction(() => {
      if (!this.get(id)) throw new MimirError("not_found", "Supervisor not found");
      if (state !== "ready" && !reason?.trim())
        throw new MimirError("validation_failed", "A waiting reason is required");
      this.db
        .prepare("UPDATE actors SET state=?,reason=?,updated=? WHERE id=?")
        .run(state, reason, this.now(), id);
      this.record(id, "state_changed", { state, reason });
    });
  }
  authorize(id: string, messageId: string, approved: boolean, reason: string) {
    this.transaction(() => {
      if (!reason.trim())
        throw new MimirError("validation_failed", "Approval evidence is required");
      const result = this.db
        .prepare(
          "UPDATE inbox SET state=?,result=? WHERE id=? AND actor=? AND state='awaiting_approval'",
        )
        .run(approved ? "pending" : "failed", reason.slice(0, 8192), messageId, id);
      if (!result.changes)
        throw new MimirError("conflict", "Message is not awaiting operator approval");
      this.record(id, "operator_authorized", { messageId, approved, reason });
    });
  }
  resolve(id: string, messageId: string, outcome: "done" | "failed", reason: string) {
    this.transaction(() => {
      if (!reason.trim())
        throw new MimirError("validation_failed", "Reconciliation evidence is required");
      const update = this.db
        .prepare("UPDATE inbox SET state=?,result=? WHERE id=? AND actor=? AND state='uncertain'")
        .run(outcome, reason.slice(0, 8192), messageId, id);
      if (!update.changes)
        throw new MimirError("conflict", "Only uncertain messages can be resolved");
      this.record(id, "operator_reconciled", { messageId, outcome, reason });
    });
  }
  messages(id: string) {
    return this.db
      .prepare(
        "SELECT id,actor,kind,body,state,result,created FROM inbox WHERE actor=? ORDER BY created DESC,id LIMIT 500",
      )
      .all(id) as Message[];
  }
  observations(id: string, after = 0) {
    return this.db
      .prepare("SELECT * FROM observations WHERE actor=? AND seq>? ORDER BY seq LIMIT 500")
      .all(id, after);
  }
  policy(actor: string): StoredPolicy | null {
    const row = this.db.prepare("SELECT * FROM policies WHERE actor=?").get(actor);
    return row
      ? {
          ...JSON.parse(String(row["body"])),
          actor,
          turns: Number(row["turns"]),
          lastQueued: Number(row["lastQueued"]),
        }
      : null;
  }
  configure(actor: string, policy: SupervisorPolicy) {
    this.transaction(() => {
      if (!this.get(actor)) throw new MimirError("not_found", "Supervisor not found");
      const prior = this.policy(actor);
      if (
        prior &&
        prior.turns > 0 &&
        (prior.missionId !== policy.missionId || prior.agentKind !== policy.agentKind)
      )
        throw new MimirError(
          "conflict",
          "Used supervisor scope and harness are immutable; register a new actor",
        );
      this.db
        .prepare(
          "INSERT INTO policies(actor,body) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET body=excluded.body",
        )
        .run(actor, JSON.stringify(policy));
      this.record(actor, "policy_configured", policy);
    });
    return this.policy(actor)!;
  }
  queueThought(actor: string, reason: string, dueOnly = false): boolean {
    return this.transaction(() => {
      const policy = this.policy(actor);
      if (!policy || !policy.enabled || policy.turns >= policy.maxTurns || !this.canDispatch(actor))
        return false;
      if (dueOnly && this.now() - policy.lastQueued < policy.intervalMs) return false;
      if (
        this.db
          .prepare(
            "SELECT id FROM inbox WHERE actor=? AND kind='think' AND state IN ('pending','dispatching','uncertain') LIMIT 1",
          )
          .get(actor)
      )
        return false;
      const id = `think:${actor}:${policy.turns + 1}`;
      const body = JSON.stringify({ missionId: policy.missionId, reason: reason.slice(0, 4096) });
      this.db
        .prepare(
          "INSERT INTO inbox(id,actor,kind,body,fingerprint,created) VALUES(?,?,'think',?,?,?)",
        )
        .run(id, actor, body, createHash("sha256").update(body).digest("hex"), this.now());
      this.db
        .prepare("UPDATE policies SET turns=turns+1,lastQueued=? WHERE actor=?")
        .run(this.now(), actor);
      this.record(actor, "thought_queued", { id, reason });
      return true;
    });
  }
  scheduleThoughts() {
    for (const actor of this.list())
      this.queueThought(actor.id, "Periodic mission supervision", true);
  }
  close() {
    this.db.close();
  }
}
