import { createHash, randomUUID } from "node:crypto";
import { bootstrapProject, type BootstrapOptions, type BootstrapResult } from "./bootstrap.js";
import { applyMigrations, openDatabase, type SqliteDatabase } from "./db.js";
import { SindriError } from "./errors.js";
import { KNOWLEDGE_MIGRATIONS } from "./schema.js";
import { search, type SearchOptions } from "./search.js";
import {
  NewEntrySchema,
  type AddEntryInput,
  type Decision,
  type DecisionStatus,
  type KnowledgeEntry,
  type NewEntry,
  type Project,
  type RecordDecisionInput,
  type RecordEvidenceInput,
  type SearchHit,
  type SourceRef,
  type TaskEvidence,
  type ErasedTaskEvidence,
  type PurgeOptions,
  type Validity,
} from "./types.js";

export interface OpenKnowledgeOptions {
  /** Injectable clock (tests, retention). */
  now?: () => Date;
}

export interface IndexedDocument {
  id: string;
  projectId: string;
  path: string;
  kind: string;
}

export interface CreateProjectInput {
  name: string;
  repoPath: string;
  settings?: Record<string, unknown>;
}

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}
interface EntryRow {
  id: string;
  project_id: string;
  claim: string;
  source_refs_json: string;
  validity: Validity;
  confidence: number;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  retracted_reason: string | null;
}
interface EvidenceRow {
  id: string;
  project_id: string;
  external_ref: string;
  kind: string;
  payload_json: string;
  created_at: string;
  content_sha256?: string | null;
  erased_at?: string | null;
}

/** SHA-256 over an evidence row's content (computed on record; legacy rows on read). */
const evidenceHash = (r: EvidenceRow) =>
  createHash("sha256")
    .update(JSON.stringify([r.project_id, r.external_ref, r.kind, r.payload_json, r.created_at]))
    .digest("hex");

type PurgeHook = (projectId: string) => void;
const purgeHooks = new WeakMap<SqliteDatabase, Map<string, PurgeHook>>();

/**
 * Register a hook that deletes another package's rows for a project. Hooks run inside
 * `projects.purge`'s transaction, before the project row is deleted (so FK cascades from
 * `projects` still find their parents' children gone first). Re-registering a name replaces it.
 */
export function registerPurgeHook(db: SqliteDatabase, name: string, hook: PurgeHook): void {
  let hooks = purgeHooks.get(db);
  if (!hooks) purgeHooks.set(db, (hooks = new Map()));
  hooks.set(name, hook);
}
interface DecisionRow {
  id: string;
  project_id: string;
  title: string;
  adr_markdown: string;
  status: DecisionStatus;
  approver: string | null;
  created_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  repoPath: r.repo_path,
  settings: JSON.parse(r.settings_json) as Record<string, unknown>,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toEntry = (r: EntryRow): KnowledgeEntry => ({
  id: r.id,
  projectId: r.project_id,
  claim: r.claim,
  sourceRefs: JSON.parse(r.source_refs_json) as SourceRef[],
  validity: r.validity,
  confidence: r.confidence,
  supersedesId: r.supersedes_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  createdBy: r.created_by,
  retractedReason: r.retracted_reason,
});
const toEvidence = (r: EvidenceRow): TaskEvidence => ({
  id: r.id,
  projectId: r.project_id,
  externalRef: r.external_ref,
  kind: r.kind,
  payload: JSON.parse(r.payload_json) as unknown,
  createdAt: r.created_at,
  contentSha256: r.content_sha256 ?? evidenceHash(r),
});
const toDecision = (r: DecisionRow): Decision => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  adrMarkdown: r.adr_markdown,
  status: r.status,
  approver: r.approver,
  createdAt: r.created_at,
});

/** Low-level stores over one database. `openKnowledge` composes these with bootstrap/search. */
export function createStores(db: SqliteDatabase, clock: () => Date) {
  const iso = () => clock().toISOString();

  const projects = {
    create(input: CreateProjectInput): Project {
      if (!input.name.trim())
        throw new SindriError("validation_failed", "project name is required");
      const ts = iso();
      const row: ProjectRow = {
        id: randomUUID(),
        name: input.name,
        repo_path: input.repoPath,
        settings_json: JSON.stringify(input.settings ?? {}),
        created_at: ts,
        updated_at: ts,
      };
      db.prepare(
        `INSERT INTO projects (id, name, repo_path, settings_json, created_at, updated_at)
         VALUES (@id, @name, @repo_path, @settings_json, @created_at, @updated_at)`,
      ).run(row);
      return toProject(row);
    },
    get(id: string): Project | undefined {
      const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
      return r && toProject(r);
    },
    list(): Project[] {
      const rows = db.prepare("SELECT * FROM projects ORDER BY created_at, rowid").all();
      return (rows as ProjectRow[]).map(toProject);
    },
    /**
     * Delete a project and every row that holds its content. Rows in other Sindri packages
     * go with it through `ON DELETE CASCADE` or the purge hooks they register
     * ({@link registerPurgeHook}). Refused while immutable task evidence exists, unless
     * `eraseEvidence` tombstones it. Deleted pages are zeroed (`secure_delete`) and the FTS
     * index is rebuilt so no indexed text of the project survives in the file.
     */
    purge(projectId: string, opts: PurgeOptions = {}): void {
      db.pragma("secure_delete = ON");
      db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId))
          throw new SindriError("not_found", `unknown project ${projectId}`);
        const evidenceRows = db
          .prepare("SELECT * FROM task_evidence WHERE project_id = ?")
          .all(projectId) as EvidenceRow[];
        if (evidenceRows.length > 0 && opts.eraseEvidence !== true)
          throw new SindriError(
            "invalid_state",
            "project has immutable task evidence; purge with eraseEvidence to tombstone it",
          );
        const erase = db.prepare(
          `UPDATE task_evidence SET project_id = NULL, external_ref = '', payload_json = 'null',
             content_sha256 = ?, erased_at = ? WHERE id = ?`,
        );
        const at = iso();
        for (const r of evidenceRows) erase.run(r.content_sha256 ?? evidenceHash(r), at, r.id);
        for (const hook of purgeHooks.get(db)?.values() ?? []) hook(projectId);
        db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')").run();
      })();
    },
  };

  /** Read-only lookup of indexed documents (for labelling source refs). */
  const documents = {
    get(id: string): IndexedDocument | undefined {
      const r = db
        .prepare("SELECT id, project_id, path, kind FROM documents WHERE id = ?")
        .get(id) as { id: string; project_id: string; path: string; kind: string } | undefined;
      return r && { id: r.id, projectId: r.project_id, path: r.path, kind: r.kind };
    },
  };

  const requireProject = (projectId: string) => {
    if (!projects.get(projectId))
      throw new SindriError("not_found", `unknown project ${projectId}`);
  };

  const getEntryRow = (id: string) =>
    db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as EntryRow | undefined;

  const validateRefs = (projectId: string, refs: SourceRef[]) => {
    for (const ref of refs) {
      if ("documentId" in ref) {
        const doc = db
          .prepare("SELECT 1 FROM documents WHERE id = ? AND project_id = ?")
          .get(ref.documentId, projectId);
        if (!doc)
          throw new SindriError(
            "validation_failed",
            `source document ${ref.documentId} not found in project`,
          );
      } else if ("taskEvidenceId" in ref) {
        const ev = db
          .prepare("SELECT 1 FROM task_evidence WHERE id = ? AND project_id = ?")
          .get(ref.taskEvidenceId, projectId);
        if (!ev)
          throw new SindriError(
            "validation_failed",
            `source task evidence ${ref.taskEvidenceId} not found in project`,
          );
      }
    }
  };

  const insertEntry = (projectId: string, input: NewEntry, supersedesId: string | null) => {
    const parsed = NewEntrySchema.safeParse(input);
    if (!parsed.success) {
      throw new SindriError(
        "validation_failed",
        `invalid knowledge entry: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const e = parsed.data;
    validateRefs(projectId, e.sourceRefs);
    const ts = iso();
    const row: EntryRow = {
      id: randomUUID(),
      project_id: projectId,
      claim: e.claim,
      source_refs_json: JSON.stringify(e.sourceRefs),
      validity: "valid",
      confidence: e.confidence,
      supersedes_id: supersedesId,
      created_at: ts,
      updated_at: ts,
      created_by: e.createdBy,
      retracted_reason: null,
    };
    db.prepare(
      `INSERT INTO knowledge_entries (id, project_id, claim, source_refs_json, validity, confidence,
         supersedes_id, created_at, updated_at, created_by, retracted_reason)
       VALUES (@id, @project_id, @claim, @source_refs_json, @validity, @confidence,
         @supersedes_id, @created_at, @updated_at, @created_by, @retracted_reason)`,
    ).run(row);
    return toEntry(row);
  };

  const knowledge = {
    add(input: AddEntryInput): KnowledgeEntry {
      requireProject(input.projectId);
      const { projectId, ...entry } = input;
      return insertEntry(projectId, entry, null);
    },
    get(id: string): KnowledgeEntry | undefined {
      const r = getEntryRow(id);
      return r && toEntry(r);
    },
    /** Replace a valid entry with a corrected one; the old entry becomes `superseded`. */
    supersede(oldId: string, newEntry: NewEntry): KnowledgeEntry {
      return db.transaction(() => {
        const old = getEntryRow(oldId);
        if (!old) throw new SindriError("not_found", `unknown knowledge entry ${oldId}`);
        if (old.validity !== "valid") {
          throw new SindriError(
            "invalid_state",
            `only valid entries can be superseded (entry is ${old.validity})`,
          );
        }
        const created = insertEntry(old.project_id, newEntry, oldId);
        db.prepare(
          "UPDATE knowledge_entries SET validity = 'superseded', updated_at = ? WHERE id = ?",
        ).run(iso(), oldId);
        return created;
      })();
    },
    retract(id: string, reason: string): KnowledgeEntry {
      if (!reason.trim())
        throw new SindriError("validation_failed", "a retraction reason is required");
      const res = db
        .prepare(
          `UPDATE knowledge_entries SET validity = 'retracted', retracted_reason = ?, updated_at = ?
           WHERE id = ? AND validity <> 'retracted'`,
        )
        .run(reason, iso(), id);
      if (res.changes === 0) {
        if (!getEntryRow(id)) throw new SindriError("not_found", `unknown knowledge entry ${id}`);
        throw new SindriError("invalid_state", `entry ${id} is already retracted`);
      }
      return toEntry(getEntryRow(id) as EntryRow);
    },
    listValid(projectId: string): KnowledgeEntry[] {
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_entries WHERE project_id = ? AND validity = 'valid'
           ORDER BY created_at, rowid`,
        )
        .all(projectId) as EntryRow[];
      return rows.map(toEntry);
    },
    /** The full supersession chain containing `id`, oldest first. */
    history(id: string): KnowledgeEntry[] {
      let cur = getEntryRow(id);
      if (!cur) return [];
      const seen = new Set<string>([cur.id]);
      while (cur.supersedes_id) {
        const prev = getEntryRow(cur.supersedes_id);
        if (!prev || seen.has(prev.id)) break;
        seen.add(prev.id);
        cur = prev;
      }
      const chain: EntryRow[] = [cur];
      const next = db.prepare(
        "SELECT * FROM knowledge_entries WHERE supersedes_id = ? ORDER BY created_at, rowid LIMIT 1",
      );
      for (;;) {
        const n = next.get((chain[chain.length - 1] as EntryRow).id) as EntryRow | undefined;
        if (!n || chain.some((c) => c.id === n.id)) break;
        chain.push(n);
      }
      return chain.map(toEntry);
    },
    /** Retention: hard-delete entries retracted more than `olderThanDays` ago. */
    purgeRetracted({ olderThanDays }: { olderThanDays: number }): number {
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        throw new RangeError("olderThanDays must be a finite, non-negative number");
      }
      const cutoff = new Date(clock().getTime() - olderThanDays * 86_400_000).toISOString();
      return db
        .prepare("DELETE FROM knowledge_entries WHERE validity = 'retracted' AND updated_at < ?")
        .run(cutoff).changes;
    },
  };

  /** Append-only: there is deliberately no update or delete API; the DB enforces it too. */
  const evidence = {
    record(input: RecordEvidenceInput): TaskEvidence {
      requireProject(input.projectId);
      const row: EvidenceRow = {
        id: randomUUID(),
        project_id: input.projectId,
        external_ref: input.externalRef,
        kind: input.kind,
        payload_json: JSON.stringify(input.payload ?? null),
        created_at: iso(),
      };
      row.content_sha256 = evidenceHash(row);
      db.prepare(
        `INSERT INTO task_evidence (id, project_id, external_ref, kind, payload_json, created_at,
           content_sha256)
         VALUES (@id, @project_id, @external_ref, @kind, @payload_json, @created_at,
           @content_sha256)`,
      ).run(row);
      return toEvidence(row);
    },
    get(id: string): TaskEvidence | undefined {
      const r = db
        .prepare("SELECT * FROM task_evidence WHERE id = ? AND erased_at IS NULL")
        .get(id) as EvidenceRow | undefined;
      return r && toEvidence(r);
    },
    /** The tombstone of evidence erased with its project, if `id` was erased. */
    erased(id: string): ErasedTaskEvidence | undefined {
      const r = db
        .prepare("SELECT * FROM task_evidence WHERE id = ? AND erased_at IS NOT NULL")
        .get(id) as EvidenceRow | undefined;
      return (
        r && {
          id: r.id,
          kind: r.kind,
          contentSha256: r.content_sha256 as string,
          createdAt: r.created_at,
          erasedAt: r.erased_at as string,
        }
      );
    },
    list(projectId: string): TaskEvidence[] {
      const rows = db
        .prepare("SELECT * FROM task_evidence WHERE project_id = ? ORDER BY created_at, rowid")
        .all(projectId) as EvidenceRow[];
      return rows.map(toEvidence);
    },
  };

  const decisions = {
    record(input: RecordDecisionInput): Decision {
      requireProject(input.projectId);
      const row: DecisionRow = {
        id: randomUUID(),
        project_id: input.projectId,
        title: input.title,
        adr_markdown: input.adrMarkdown,
        status: input.status ?? "proposed",
        approver: input.approver ?? null,
        created_at: iso(),
      };
      db.prepare(
        `INSERT INTO decisions (id, project_id, title, adr_markdown, status, approver, created_at)
         VALUES (@id, @project_id, @title, @adr_markdown, @status, @approver, @created_at)`,
      ).run(row);
      return toDecision(row);
    },
    get(id: string): Decision | undefined {
      const r = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
        DecisionRow | undefined;
      return r && toDecision(r);
    },
    list(projectId: string): Decision[] {
      const rows = db
        .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at, rowid")
        .all(projectId) as DecisionRow[];
      return rows.map(toDecision);
    },
  };

  return { projects, documents, knowledge, evidence, decisions };
}

export type Knowledge = ReturnType<typeof createStores> & {
  readonly db: SqliteDatabase;
  /** Index the project's repo (README, docs, manifests, ADRs, test commands, structure). */
  bootstrapProject(projectId: string, options: BootstrapOptions): BootstrapResult;
  /** FTS5 (bm25-ranked) search over indexed chunks of one project. */
  search(projectId: string, query: string, options?: SearchOptions): SearchHit[];
  close(): void;
};

/**
 * Open the knowledge store at `pathOrDb` (a file path, ":memory:", or an already-open
 * database shared with other Sindri packages) and apply its migrations.
 */
export function openKnowledge(
  pathOrDb: string | SqliteDatabase,
  options: OpenKnowledgeOptions = {},
): Knowledge {
  const db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  const clock = options.now ?? (() => new Date());
  return {
    db,
    ...createStores(db, clock),
    bootstrapProject: (projectId, opts) => bootstrapProject(db, projectId, opts, clock),
    search: (projectId, query, opts) => search(db, projectId, query, opts),
    close: () => db.close(),
  };
}
