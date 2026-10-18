import { randomUUID } from "node:crypto";
import { INTAKE_MIGRATIONS } from "@sindri/intake";
import {
  applyMigrations,
  SindriError,
  type SindriErrorCode,
  KNOWLEDGE_MIGRATIONS,
  openDatabase,
  type SqliteDatabase,
} from "@sindri/knowledge";
import type { z } from "zod";
import {
  ProvenanceSchema,
  SpecBodySchema,
  type Provenance,
  type ProvenanceRef,
  type SpecBody,
} from "./body.js";
import { diffSpecs, type SpecDiff } from "./diff.js";
import { renderSpec } from "./render.js";
import { SPECS_MIGRATIONS } from "./schema.js";

export type SpecStatus = "draft" | "review" | "approved" | "superseded";

export interface Specification {
  id: string;
  projectId: string;
  intakeId: string | null;
  lineageId: string;
  version: number;
  status: SpecStatus;
  title: string;
  body: SpecBody;
  provenance: Provenance;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface CreateDraftInput {
  projectId: string;
  intakeId?: string;
  title: string;
  body: SpecBody;
  provenance: Provenance;
}

export interface RevisePatch {
  title?: string;
  /** Shallow per-section replacement. */
  body?: Partial<SpecBody>;
  /** Shallow per-section replacement. */
  provenance?: Partial<Provenance>;
}

export interface OpenSpecsOptions {
  now?: () => Date;
}

export class SpecValidationError extends SindriError {
  override name = "SpecValidationError";
  constructor(message: string, code: SindriErrorCode = "validation_failed") {
    super(code, message);
  }
}
export class SpecStateError extends SindriError {
  override name = "SpecStateError";
  constructor(message: string, code: SindriErrorCode = "invalid_state") {
    super(code, message);
  }
}

interface SpecRow {
  id: string;
  project_id: string;
  intake_id: string | null;
  lineage_id: string;
  version: number;
  status: SpecStatus;
  title: string;
  body_json: string;
  provenance_json: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

const toSpec = (r: SpecRow): Specification => ({
  id: r.id,
  projectId: r.project_id,
  intakeId: r.intake_id,
  lineageId: r.lineage_id,
  version: r.version,
  status: r.status,
  title: r.title,
  body: JSON.parse(r.body_json) as SpecBody,
  provenance: JSON.parse(r.provenance_json) as Provenance,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
});

const issues = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

export function openSpecs(pathOrDb: string | SqliteDatabase, options: OpenSpecsOptions = {}) {
  const db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  applyMigrations(db, "intake", INTAKE_MIGRATIONS);
  applyMigrations(db, "specs", SPECS_MIGRATIONS);
  const clock = options.now ?? (() => new Date());
  const iso = () => clock().toISOString();

  const getRow = (id: string) =>
    db.prepare("SELECT * FROM specifications WHERE id = ?").get(id) as SpecRow | undefined;
  const mustGet = (id: string) => {
    const r = getRow(id);
    if (!r) throw new SpecStateError(`unknown specification ${id}`, "not_found");
    return r;
  };
  const latestVersion = (lineageId: string) =>
    (
      db
        .prepare("SELECT MAX(version) AS v FROM specifications WHERE lineage_id = ?")
        .get(lineageId) as { v: number }
    ).v;
  const requireLatest = (r: SpecRow, action: string) => {
    if (r.version !== latestVersion(r.lineage_id)) {
      throw new SpecStateError(`can only ${action} the latest version of a lineage`);
    }
  };

  const checkRef = (projectId: string, ref: ProvenanceRef, where: string) => {
    const exists = (sql: string, id: string) => !!db.prepare(sql).get(id, projectId);
    if ("knowledgeEntryId" in ref) {
      if (
        !exists(
          "SELECT 1 FROM knowledge_entries WHERE id = ? AND project_id = ?",
          ref.knowledgeEntryId,
        )
      )
        throw new SpecValidationError(
          `${where}: knowledge entry ${ref.knowledgeEntryId} not found`,
        );
    } else if ("taskEvidenceId" in ref) {
      if (
        !exists("SELECT 1 FROM task_evidence WHERE id = ? AND project_id = ?", ref.taskEvidenceId)
      )
        throw new SpecValidationError(`${where}: task evidence ${ref.taskEvidenceId} not found`);
    } else if ("intakeId" in ref) {
      if (!exists("SELECT 1 FROM intakes WHERE id = ? AND project_id = ?", ref.intakeId))
        throw new SpecValidationError(`${where}: intake ${ref.intakeId} not found`);
    } else if (!exists("SELECT 1 FROM documents WHERE id = ? AND project_id = ?", ref.documentId)) {
      throw new SpecValidationError(`${where}: document ${ref.documentId} not found`);
    }
  };

  const validate = (projectId: string, title: string, body: unknown, provenance: unknown) => {
    if (!title.trim()) throw new SpecValidationError("title is required");
    const b = SpecBodySchema.safeParse(body);
    if (!b.success) throw new SpecValidationError(`invalid spec body: ${issues(b.error)}`);
    const p = ProvenanceSchema.safeParse(provenance);
    if (!p.success) throw new SpecValidationError(`invalid provenance: ${issues(p.error)}`);
    const acIds = new Set(b.data.acceptanceCriteria.map((a) => a.id));
    for (const id of acIds) {
      if (!p.data.acceptanceCriteria[id]?.length) {
        throw new SpecValidationError(
          `provenance for acceptance criterion ${id} must not be empty`,
        );
      }
    }
    for (const id of Object.keys(p.data.acceptanceCriteria)) {
      if (!acIds.has(id)) {
        throw new SpecValidationError(`provenance references unknown acceptance criterion ${id}`);
      }
    }
    for (const [section, value] of Object.entries(p.data)) {
      const list = Array.isArray(value) ? value : Object.values(value).flat();
      for (const ref of list) checkRef(projectId, ref, `provenance.${section}`);
    }
    return { body: b.data, provenance: p.data };
  };

  const insert = (row: SpecRow) => {
    db.prepare(
      `INSERT INTO specifications (id, project_id, intake_id, lineage_id, version, status, title,
         body_json, provenance_json, approved_by, approved_at, created_at)
       VALUES (@id, @project_id, @intake_id, @lineage_id, @version, @status, @title,
         @body_json, @provenance_json, @approved_by, @approved_at, @created_at)`,
    ).run(row);
    return toSpec(row);
  };

  const api = {
    db,

    createDraft(input: CreateDraftInput): Specification {
      if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
        throw new SpecValidationError(`unknown project ${input.projectId}`, "not_found");
      }
      if (input.intakeId !== undefined)
        checkRef(input.projectId, { intakeId: input.intakeId }, "intakeId");
      const v = validate(input.projectId, input.title, input.body, input.provenance);
      return insert({
        id: randomUUID(),
        project_id: input.projectId,
        intake_id: input.intakeId ?? null,
        lineage_id: randomUUID(),
        version: 1,
        status: "draft",
        title: input.title,
        body_json: JSON.stringify(v.body),
        provenance_json: JSON.stringify(v.provenance),
        approved_by: null,
        approved_at: null,
        created_at: iso(),
      });
    },

    get(id: string): Specification | undefined {
      const r = getRow(id);
      return r && toSpec(r);
    },

    /** New draft version in the same lineage. Earlier versions are untouched until approval. */
    revise(id: string, patch: RevisePatch): Specification {
      return db.transaction(() => {
        const prev = mustGet(id);
        requireLatest(prev, "revise");
        if (prev.status === "superseded")
          throw new SpecStateError("cannot revise a superseded spec");
        const old = toSpec(prev);
        const title = patch.title ?? old.title;
        const v = validate(
          old.projectId,
          title,
          { ...old.body, ...patch.body },
          { ...old.provenance, ...patch.provenance },
        );
        return insert({
          id: randomUUID(),
          project_id: prev.project_id,
          intake_id: prev.intake_id,
          lineage_id: prev.lineage_id,
          version: prev.version + 1,
          status: "draft",
          title,
          body_json: JSON.stringify(v.body),
          provenance_json: JSON.stringify(v.provenance),
          approved_by: null,
          approved_at: null,
          created_at: iso(),
        });
      })();
    },

    submitForReview(id: string): Specification {
      const r = mustGet(id);
      requireLatest(r, "submit");
      if (r.status !== "draft")
        throw new SpecStateError(`only drafts can be submitted (is ${r.status})`);
      db.prepare("UPDATE specifications SET status = 'review' WHERE id = ?").run(id);
      return toSpec(mustGet(id));
    },

    /**
     * Approve a spec in review. Rejected while any open question is blocking. On approval
     * every other non-superseded version of the lineage becomes `superseded`.
     */
    approve(id: string, { approver }: { approver: string }): Specification {
      if (!approver.trim()) throw new SpecValidationError("approver is required");
      return db.transaction(() => {
        const r = mustGet(id);
        requireLatest(r, "approve");
        if (r.status !== "review") {
          throw new SpecStateError(`only specs in review can be approved (is ${r.status})`);
        }
        const blocking = toSpec(r).body.openQuestions.filter((q) => q.blocking);
        if (blocking.length) {
          throw new SpecStateError(
            `cannot approve with blocking open questions: ${blocking.map((q) => q.id).join(", ")}`,
          );
        }
        db.prepare(
          "UPDATE specifications SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
        ).run(approver, iso(), id);
        db.prepare(
          `UPDATE specifications SET status = 'superseded'
           WHERE lineage_id = ? AND id <> ? AND status <> 'superseded'`,
        ).run(r.lineage_id, id);
        return toSpec(mustGet(id));
      })();
    },

    /** Structured diff between two versions of the same lineage. */
    diff(fromId: string, toId: string): SpecDiff {
      const a = toSpec(mustGet(fromId));
      const b = toSpec(mustGet(toId));
      if (a.lineageId !== b.lineageId)
        throw new SpecStateError("can only diff versions of one lineage");
      return diffSpecs(a, b);
    },

    render(id: string): string {
      return renderSpec(toSpec(mustGet(id)));
    },

    /** Every version of every spec in a project, by creation then lineage and version. */
    listByProject(projectId: string): Specification[] {
      return (
        db
          .prepare("SELECT * FROM specifications WHERE project_id = ? ORDER BY created_at, rowid")
          .all(projectId) as SpecRow[]
      ).map(toSpec);
    },

    listLineage(lineageId: string): Specification[] {
      return (
        db
          .prepare("SELECT * FROM specifications WHERE lineage_id = ? ORDER BY version")
          .all(lineageId) as SpecRow[]
      ).map(toSpec);
    },

    close: () => db.close(),
  };
  return api;
}

export type Specs = ReturnType<typeof openSpecs>;
