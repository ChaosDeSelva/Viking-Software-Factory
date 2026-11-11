import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@sindri/knowledge";
import { ensureStewardSchema } from "./schema.js";
import {
  APPROVAL_TYPES,
  DECISION_TYPES,
  type Decision,
  type DecisionInput,
  type DecisionStatus,
  type DecisionType,
  type Guidance,
  type HistoryEntry,
  type Mode,
  type Note,
  type Outcome,
  type StewardType,
  type SubjectKind,
  type TypeStats,
} from "./types.js";

interface DecisionRow {
  id: string;
  project_id: string;
  type: DecisionType;
  dedupe_key: string;
  subject_kind: SubjectKind;
  subject_id: string;
  subject_label: string;
  context_json: string;
  inputs_json: string;
  recommendation_value: string;
  recommendation_detail: string | null;
  reasoning: string;
  confidence: number;
  mode: "recommend" | "auto";
  status: DecisionStatus;
  final_value: string | null;
  applied_json: string | null;
  outcome_json: string | null;
  reversible: number;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

interface NoteRow {
  id: string;
  project_id: string | null;
  decision_id: string | null;
  author: string;
  text: string;
  created_at: string;
}

interface GuidanceRow {
  id: string;
  project_id: string;
  type: DecisionType;
  signature: string;
  rule: string;
  decision_ids_json: string;
  status: Guidance["status"];
  entry_id: string | null;
  evidence_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

/** A decision with the stored fields the API does not show. */
export interface StoredDecision extends Decision {
  dedupeKey: string;
  context: unknown;
  applied: Record<string, unknown> | null;
  attempts: number;
}

/** Fields a decision update may change. Each update is recorded in the history. */
export interface DecisionPatch {
  inputs?: DecisionInput[];
  recommendation?: { value: string; detail?: string | undefined };
  reasoning?: string;
  confidence?: number;
  mode?: "recommend" | "auto";
  status?: DecisionStatus;
  finalValue?: string | null;
  applied?: Record<string, unknown> | null;
  outcome?: Outcome | null;
  reversible?: boolean;
  error?: string | null;
  attempts?: number;
  decidedAt?: string | null;
}

export interface NewDecision {
  projectId: string;
  type: DecisionType;
  dedupeKey: string;
  subject: { kind: SubjectKind; id: string; label: string };
  context: unknown;
  mode: "recommend" | "auto";
}

export interface ListFilter {
  projectId?: string;
  type?: DecisionType;
  status?: DecisionStatus;
  limit?: number;
  /** A decision id or an ISO timestamp: only decisions created before it. */
  before?: string;
}

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  projectId: r.project_id,
  decisionId: r.decision_id,
  author: r.author,
  text: r.text,
  createdAt: r.created_at,
});

const toGuidance = (r: GuidanceRow): Guidance => ({
  id: r.id,
  projectId: r.project_id,
  type: r.type,
  rule: r.rule,
  decisionIds: JSON.parse(r.decision_ids_json) as string[],
  status: r.status,
  entryId: r.entry_id,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  reason: r.reason,
  createdAt: r.created_at,
});

/** Statuses the operator (or auto mode) has decided, by current status. */
const DECIDED: readonly DecisionStatus[] = [
  "accepted",
  "changed",
  "rejected",
  "applied",
  "rolled_back",
];

/** Persistence of decisions, their history, notes, modes and guidance proposals. */
export class StewardStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    ensureStewardSchema(db);
  }

  get db(): SqliteDatabase {
    return this.#db;
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #toDecision(r: DecisionRow, withHistory = false): StoredDecision {
    const rec: { value: string; detail?: string } = { value: r.recommendation_value };
    if (r.recommendation_detail !== null) rec.detail = r.recommendation_detail;
    const d: StoredDecision = {
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      subject: { kind: r.subject_kind, id: r.subject_id, label: r.subject_label },
      inputs: JSON.parse(r.inputs_json) as DecisionInput[],
      recommendation: rec,
      reasoning: r.reasoning,
      confidence: r.confidence,
      mode: r.mode,
      status: r.status,
      outcome: r.outcome_json ? (JSON.parse(r.outcome_json) as Outcome) : null,
      reversible: r.reversible === 1,
      notes: this.notesOf(r.id),
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      appliedValue: r.final_value,
      error: r.error,
      dedupeKey: r.dedupe_key,
      context: JSON.parse(r.context_json) as unknown,
      applied: r.applied_json ? (JSON.parse(r.applied_json) as Record<string, unknown>) : null,
      attempts: r.attempts,
    };
    if (withHistory) d.history = this.history(r.id);
    return d;
  }

  /** The public view of a decision (no internal fields). */
  static view(d: StoredDecision): Decision {
    const out: Partial<StoredDecision> = { ...d };
    delete out.dedupeKey;
    delete out.context;
    delete out.applied;
    delete out.attempts;
    return out as Decision;
  }

  get(id: string, opts: { history?: boolean } = {}): StoredDecision | undefined {
    const r = this.#db.prepare("SELECT * FROM steward_decisions WHERE id = ?").get(id) as
      DecisionRow | undefined;
    return r && this.#toDecision(r, opts.history === true);
  }

  byKey(type: DecisionType, dedupeKey: string): StoredDecision | undefined {
    const r = this.#db
      .prepare("SELECT * FROM steward_decisions WHERE type = ? AND dedupe_key = ?")
      .get(type, dedupeKey) as DecisionRow | undefined;
    return r && this.#toDecision(r);
  }

  /** Newest first. */
  list(f: ListFilter = {}): StoredDecision[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.projectId) {
      where.push("project_id = ?");
      params.push(f.projectId);
    }
    if (f.type) {
      where.push("type = ?");
      params.push(f.type);
    }
    if (f.status) {
      where.push("status = ?");
      params.push(f.status);
    }
    if (f.before) {
      const anchor = this.#db
        .prepare("SELECT created_at, rowid FROM steward_decisions WHERE id = ?")
        .get(f.before) as { created_at: string; rowid: number } | undefined;
      if (anchor) {
        where.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
        params.push(anchor.created_at, anchor.created_at, anchor.rowid);
      } else {
        where.push("created_at < ?");
        params.push(f.before);
      }
    }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const rows = this.#db
      .prepare(
        `SELECT * FROM steward_decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as DecisionRow[];
    return rows.map((r) => this.#toDecision(r));
  }

  pending(type?: DecisionType): StoredDecision[] {
    const rows = (
      type
        ? this.#db
            .prepare(
              "SELECT * FROM steward_decisions WHERE status = 'pending' AND type = ? ORDER BY created_at, rowid",
            )
            .all(type)
        : this.#db
            .prepare(
              "SELECT * FROM steward_decisions WHERE status = 'pending' ORDER BY created_at, rowid",
            )
            .all()
    ) as DecisionRow[];
    return rows.map((r) => this.#toDecision(r));
  }

  /** Applied decisions whose later result may still change (newest first, bounded). */
  awaitingOutcome(limit = 200): StoredDecision[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM steward_decisions
         WHERE status IN ('accepted', 'changed', 'applied') AND final_value IS NOT NULL
           AND (outcome_json IS NULL OR json_extract(outcome_json, '$.result') IN ('passed', 'unknown'))
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as DecisionRow[];
    return rows.map((r) => this.#toDecision(r));
  }

  /** Decisions of a subject with this status and applied value. */
  countApplied(
    type: DecisionType,
    subjectId: string,
    value: string,
    status: DecisionStatus,
  ): number {
    return (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM steward_decisions
           WHERE type = ? AND subject_id = ? AND final_value = ? AND status = ?`,
        )
        .get(type, subjectId, value, status) as { n: number }
    ).n;
  }

  /** Decided decisions of a type in a project, newest first. */
  decided(projectId: string, type: DecisionType, limit = 200): StoredDecision[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM steward_decisions WHERE project_id = ? AND type = ?
           AND status IN (${DECIDED.map(() => "?").join(", ")})
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(projectId, type, ...DECIDED, limit) as DecisionRow[];
    return rows.map((r) => this.#toDecision(r));
  }

  /**
   * Creates a pending decision, or returns undefined when the type already has one for this
   * dedupe key, or a pending one for this subject (idempotent production).
   */
  create(input: NewDecision): StoredDecision | undefined {
    const id = `sd_${randomUUID()}`;
    const at = this.#iso();
    return this.#db.transaction(() => {
      const res = this.#db
        .prepare(
          `INSERT OR IGNORE INTO steward_decisions (id, project_id, type, dedupe_key, subject_kind,
             subject_id, subject_label, context_json, mode, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.type,
          input.dedupeKey,
          input.subject.kind,
          input.subject.id,
          input.subject.label,
          JSON.stringify(input.context ?? null),
          input.mode,
          at,
          at,
        );
      if (res.changes === 0) return undefined;
      this.#history(id, input.projectId, "created", "steward", {
        subject: input.subject,
        mode: input.mode,
      });
      return this.get(id);
    })();
  }

  /**
   * The only way a decision row changes: the update and its history entry are one
   * transaction. `expect` guards the transition (e.g. only from `pending`); a mismatch returns
   * undefined and changes nothing.
   */
  update(
    id: string,
    patch: DecisionPatch,
    entry: { action: string; actor: string; detail?: unknown },
    expect?: { status?: DecisionStatus | readonly DecisionStatus[] },
  ): StoredDecision | undefined {
    return this.#db.transaction(() => {
      const cur = this.#db.prepare("SELECT * FROM steward_decisions WHERE id = ?").get(id) as
        DecisionRow | undefined;
      if (!cur) return undefined;
      if (expect?.status !== undefined) {
        const allowed = typeof expect.status === "string" ? [expect.status] : expect.status;
        if (!allowed.includes(cur.status)) return undefined;
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => {
        sets.push(`${col} = ?`);
        params.push(v);
      };
      if (patch.inputs !== undefined) set("inputs_json", JSON.stringify(patch.inputs));
      if (patch.recommendation !== undefined) {
        set("recommendation_value", patch.recommendation.value);
        set("recommendation_detail", patch.recommendation.detail ?? null);
      }
      if (patch.reasoning !== undefined) set("reasoning", patch.reasoning);
      if (patch.confidence !== undefined)
        set("confidence", Math.min(1, Math.max(0, patch.confidence)));
      if (patch.mode !== undefined) set("mode", patch.mode);
      if (patch.status !== undefined) set("status", patch.status);
      if (patch.finalValue !== undefined) set("final_value", patch.finalValue);
      if (patch.applied !== undefined)
        set("applied_json", patch.applied === null ? null : JSON.stringify(patch.applied));
      if (patch.outcome !== undefined)
        set("outcome_json", patch.outcome === null ? null : JSON.stringify(patch.outcome));
      if (patch.reversible !== undefined) set("reversible", patch.reversible ? 1 : 0);
      if (patch.error !== undefined) set("error", patch.error);
      if (patch.attempts !== undefined) set("attempts", patch.attempts);
      if (patch.decidedAt !== undefined) set("decided_at", patch.decidedAt);
      set("updated_at", this.#iso());
      this.#db
        .prepare(`UPDATE steward_decisions SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params, id);
      this.#history(id, cur.project_id, entry.action, entry.actor, {
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
        changes: patch,
        previous: { status: cur.status },
      });
      return this.get(id);
    })();
  }

  #history(id: string, projectId: string, action: string, actor: string, detail: unknown) {
    this.#db
      .prepare(
        `INSERT INTO steward_decision_history (decision_id, project_id, action, actor, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, action, actor, JSON.stringify(detail ?? null), this.#iso());
  }

  /** Records an event on a decision without changing the row (e.g. an apply failure). */
  record(id: string, action: string, actor: string, detail: unknown): void {
    const d = this.get(id);
    if (d) this.#history(id, d.projectId, action, actor, detail);
  }

  history(id: string): HistoryEntry[] {
    return (
      this.#db
        .prepare(
          "SELECT action, actor, detail_json, created_at FROM steward_decision_history WHERE decision_id = ? ORDER BY seq",
        )
        .all(id) as { action: string; actor: string; detail_json: string; created_at: string }[]
    ).map((r) => ({
      action: r.action,
      actor: r.actor,
      detail: JSON.parse(r.detail_json) as unknown,
      createdAt: r.created_at,
    }));
  }

  // ------------------------------------------------------------------ notes

  addNote(input: {
    projectId: string | null;
    decisionId?: string | null;
    author: string;
    text: string;
  }): Note {
    const row: NoteRow = {
      id: `sn_${randomUUID()}`,
      project_id: input.projectId,
      decision_id: input.decisionId ?? null,
      author: input.author,
      text: input.text,
      created_at: this.#iso(),
    };
    this.#db
      .prepare(
        `INSERT INTO steward_notes (id, project_id, decision_id, author, text, created_at)
         VALUES (@id, @project_id, @decision_id, @author, @text, @created_at)`,
      )
      .run(row);
    if (row.decision_id && row.project_id)
      this.#history(row.decision_id, row.project_id, "note", input.author, { noteId: row.id });
    return toNote(row);
  }

  notesOf(decisionId: string): Note[] {
    return (
      this.#db
        .prepare("SELECT * FROM steward_notes WHERE decision_id = ? ORDER BY created_at, rowid")
        .all(decisionId) as NoteRow[]
    ).map(toNote);
  }

  /**
   * Operator notes, newest first: with a project, that project's notes and the global ones;
   * with null, global notes only; without an argument, every note.
   */
  notes(projectId?: string | null, limit = 200): Note[] {
    const rows =
      projectId === undefined
        ? this.#db
            .prepare("SELECT * FROM steward_notes ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .all(limit)
        : projectId === null
          ? this.#db
              .prepare(
                "SELECT * FROM steward_notes WHERE project_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
              )
              .all(limit)
          : this.#db
              .prepare(
                `SELECT * FROM steward_notes WHERE project_id = ? OR project_id IS NULL
                 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
              )
              .all(projectId, limit);
    return (rows as NoteRow[]).map(toNote);
  }

  // ------------------------------------------------------------------ modes and state

  mode(type: DecisionType): Mode {
    const r = this.#db.prepare("SELECT mode FROM steward_modes WHERE type = ?").get(type) as
      { mode: Mode } | undefined;
    return r?.mode ?? "recommend";
  }

  setMode(type: DecisionType, mode: Mode, actor: string): void {
    this.#db
      .prepare(
        `INSERT INTO steward_modes (type, mode, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (type) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(type, mode, actor, this.#iso());
  }

  paused(): boolean {
    const r = this.#db.prepare("SELECT paused FROM steward_state WHERE id = 1").get() as
      { paused: number } | undefined;
    return r?.paused === 1;
  }

  setPaused(paused: boolean, actor: string): void {
    this.#db
      .prepare(
        `INSERT INTO steward_state (id, paused, updated_by, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET paused = excluded.paused, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(paused ? 1 : 0, actor, this.#iso());
  }

  stats(type: DecisionType): TypeStats {
    const rows = this.#db
      .prepare(
        `SELECT status, COUNT(*) AS n,
                SUM(CASE WHEN outcome_json IS NOT NULL AND json_extract(outcome_json, '$.result') = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM steward_decisions WHERE type = ? GROUP BY status`,
      )
      .all(type) as { status: DecisionStatus; n: number; failed: number }[];
    const n = (s: DecisionStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    const appliedFailed = rows.find((r) => r.status === "applied")?.failed ?? 0;
    const decided = DECIDED.reduce((sum, s) => sum + n(s), 0);
    return {
      decided,
      accepted: n("accepted"),
      changed: n("changed"),
      rejected: n("rejected"),
      rolledBack: n("rolled_back"),
      autoApplied: n("applied"),
      accuracy: decided === 0 ? null : (n("accepted") + n("applied") - appliedFailed) / decided,
    };
  }

  types(): StewardType[] {
    return DECISION_TYPES.map((type) => ({
      type,
      mode: this.mode(type),
      autoAllowed: !APPROVAL_TYPES.has(type),
      stats: this.stats(type),
    }));
  }

  // ------------------------------------------------------------------ guidance

  proposeGuidance(input: {
    projectId: string;
    type: DecisionType;
    signature: string;
    rule: string;
    decisionIds: string[];
  }): Guidance | undefined {
    const id = `sg_${randomUUID()}`;
    const res = this.#db
      .prepare(
        `INSERT OR IGNORE INTO steward_guidance (id, project_id, type, signature, rule,
           decision_ids_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        id,
        input.projectId,
        input.type,
        input.signature,
        input.rule,
        JSON.stringify(input.decisionIds),
        this.#iso(),
      );
    return res.changes === 0 ? undefined : this.guidance(id);
  }

  guidance(id: string): Guidance | undefined {
    const r = this.#db.prepare("SELECT * FROM steward_guidance WHERE id = ?").get(id) as
      GuidanceRow | undefined;
    return r && toGuidance(r);
  }

  listGuidance(projectId?: string): Guidance[] {
    const rows = (
      projectId
        ? this.#db
            .prepare(
              "SELECT * FROM steward_guidance WHERE project_id = ? ORDER BY created_at DESC, rowid DESC",
            )
            .all(projectId)
        : this.#db
            .prepare("SELECT * FROM steward_guidance ORDER BY created_at DESC, rowid DESC")
            .all()
    ) as GuidanceRow[];
    return rows.map(toGuidance);
  }

  hasGuidance(projectId: string, type: DecisionType, signature: string): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM steward_guidance WHERE project_id = ? AND type = ? AND signature = ?",
        )
        .get(projectId, type, signature) !== undefined
    );
  }

  decideGuidance(
    id: string,
    patch: {
      status: "accepted" | "rejected";
      by: string;
      reason?: string | null;
      entryId?: string | null;
      evidenceId?: string | null;
    },
  ): Guidance | undefined {
    const res = this.#db
      .prepare(
        `UPDATE steward_guidance SET status = ?, decided_by = ?, decided_at = ?, reason = ?,
           entry_id = ?, evidence_id = ? WHERE id = ? AND status = 'proposed'`,
      )
      .run(
        patch.status,
        patch.by,
        this.#iso(),
        patch.reason ?? null,
        patch.entryId ?? null,
        patch.evidenceId ?? null,
        id,
      );
    return res.changes === 0 ? undefined : this.guidance(id);
  }

  /** Entry ids of accepted guidance, so retrieval can label them `guidance`. */
  guidanceEntryIds(projectId: string): Set<string> {
    return new Set(
      (
        this.#db
          .prepare(
            "SELECT entry_id FROM steward_guidance WHERE project_id = ? AND status = 'accepted' AND entry_id IS NOT NULL",
          )
          .all(projectId) as { entry_id: string }[]
      ).map((r) => r.entry_id),
    );
  }
}
