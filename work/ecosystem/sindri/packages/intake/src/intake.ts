import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  SindriError,
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  openDatabase,
  type SqliteDatabase,
} from "@sindri/knowledge";
import type { Connector, IssueComment, IssueSnapshot } from "./connectors.js";
import { sanitizeForDisplay } from "./sanitize.js";
import { INTAKE_MIGRATIONS } from "./schema.js";

export type IntakeSource = "manual" | "jira" | "linear";
export type SyncState = "imported" | "stale" | "conflict";

/** What was stored for a ticket: normalised fields plus the untouched remote payload. */
export interface StoredSnapshot {
  title: string;
  /** Untrusted text; render only via sanitizeForDisplay. */
  body: string;
  updated: string;
  url: string | null;
  status?: string;
  raw: unknown;
  rawComments?: unknown;
  /** Normalised remote comments; only present on a pending snapshot. */
  comments?: IssueComment[];
}

export interface IntakePermissions {
  comments: boolean;
  attachments: boolean;
}

export interface IntakeRecord {
  id: string;
  projectId: string;
  source: IntakeSource;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  body: string;
  snapshot: StoredSnapshot;
  /** Incoming remote snapshot awaiting resolution when state is stale/conflict. */
  pendingSnapshot: StoredSnapshot | null;
  importedAt: string;
  syncState: SyncState;
  permissions: IntakePermissions;
  createdAt: string;
  /** Title and body sanitized for display when the row was written (audit M5). */
  display: { title: string; body: string };
}

export interface IntakeAttachment {
  id: string;
  intakeId: string;
  name: string;
  bytes: number;
  sha256: string;
  path: string;
}

export interface IntakeCommentRecord {
  id: string;
  intakeId: string;
  author: string;
  body: string;
  createdAt: string;
  externalId: string | null;
  origin: "remote" | "local";
  /** Author and body sanitized for display when the comment was written (audit M5). */
  display: { author: string; body: string };
}

export interface ManualAttachmentInput {
  name: string;
  content: string | Uint8Array;
}

export interface CreateManualInput {
  projectId: string;
  title: string;
  body: string;
  attachments?: ManualAttachmentInput[];
}

export interface ImportOptions {
  projectId: string;
  /** Import remote comments (default true). Recorded in permissions_json. */
  importComments?: boolean;
}

export interface OpenIntakeOptions {
  connectors?: Connector[];
  /** Directory for manual attachment blobs (content-addressed). Required to attach files. */
  attachmentsDir?: string;
  now?: () => Date;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface IntakeRow {
  id: string;
  project_id: string;
  source: IntakeSource;
  external_id: string | null;
  external_url: string | null;
  title: string;
  raw_snapshot_json: string;
  imported_at: string;
  sync_state: SyncState;
  permissions_json: string;
  created_at: string;
  pending_snapshot_json: string | null;
  acknowledged_remote_updated?: string | null;
  display_title: string | null;
  display_body: string | null;
}

const toRecord = (r: IntakeRow): IntakeRecord => {
  const snapshot = JSON.parse(r.raw_snapshot_json) as StoredSnapshot;
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    externalId: r.external_id,
    externalUrl: r.external_url,
    title: r.title,
    body: snapshot.body,
    snapshot,
    pendingSnapshot: r.pending_snapshot_json
      ? (JSON.parse(r.pending_snapshot_json) as StoredSnapshot)
      : null,
    importedAt: r.imported_at,
    syncState: r.sync_state,
    permissions: JSON.parse(r.permissions_json) as IntakePermissions,
    createdAt: r.created_at,
    // Written with the row (openIntake backfills older rows), so reads never re-sanitize.
    display: {
      title: r.display_title ?? sanitizeForDisplay(r.title),
      body: r.display_body ?? sanitizeForDisplay(snapshot.body),
    },
  };
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function safeName(name: string): string {
  const n = basename(name.replace(/\\/g, "/")).replace(CONTROL_CHARS, "").trim();
  return n && n !== "." && n !== ".." ? n.slice(0, 255) : "attachment";
}

/** Largest raw connector payload kept in a snapshot (review m6). */
export const MAX_RAW_PAYLOAD_BYTES = 256 * 1024;

/** The raw payload, or a size marker when it is larger than {@link MAX_RAW_PAYLOAD_BYTES}. */
function capRaw(raw: unknown): unknown {
  const bytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  return bytes > MAX_RAW_PAYLOAD_BYTES ? { truncated: true, bytes } : raw;
}

function toStored(s: IssueSnapshot, rawComments?: unknown): StoredSnapshot {
  const out: StoredSnapshot = {
    title: s.title,
    body: s.body,
    updated: s.updated,
    url: s.url,
    raw: capRaw(s.raw),
  };
  if (s.status !== undefined) out.status = s.status;
  if (rawComments !== undefined) out.rawComments = capRaw(rawComments);
  return out;
}

/** Sanitizes display text once for rows written before the display columns existed. */
function backfillDisplay(db: SqliteDatabase): void {
  const intakes = db
    .prepare("SELECT id, title, raw_snapshot_json FROM intakes WHERE display_title IS NULL")
    .all() as { id: string; title: string; raw_snapshot_json: string }[];
  const comments = db
    .prepare("SELECT id, author, body FROM intake_comments WHERE display_body IS NULL")
    .all() as { id: string; author: string; body: string }[];
  if (intakes.length === 0 && comments.length === 0) return;
  const setIntake = db.prepare(
    "UPDATE intakes SET display_title = ?, display_body = ? WHERE id = ?",
  );
  const setComment = db.prepare(
    "UPDATE intake_comments SET display_author = ?, display_body = ? WHERE id = ?",
  );
  db.transaction(() => {
    for (const r of intakes) {
      const body = (JSON.parse(r.raw_snapshot_json) as { body?: string }).body ?? "";
      setIntake.run(sanitizeForDisplay(r.title), sanitizeForDisplay(body), r.id);
    }
    for (const c of comments)
      setComment.run(sanitizeForDisplay(c.author), sanitizeForDisplay(c.body), c.id);
  })();
}

export function openIntake(pathOrDb: string | SqliteDatabase, options: OpenIntakeOptions = {}) {
  const db = typeof pathOrDb === "string" ? openDatabase(pathOrDb) : pathOrDb;
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  applyMigrations(db, "intake", INTAKE_MIGRATIONS);
  backfillDisplay(db);
  const clock = options.now ?? (() => new Date());
  const iso = () => clock().toISOString();
  const connectors = options.connectors ?? [];

  const getRow = (id: string) =>
    db.prepare("SELECT * FROM intakes WHERE id = ?").get(id) as IntakeRow | undefined;
  const mustGet = (id: string) => {
    const r = getRow(id);
    if (!r) throw new SindriError("not_found", `unknown intake ${id}`);
    return r;
  };
  const requireProject = (projectId: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new SindriError("not_found", `unknown project ${projectId}`);
    }
  };
  const insertCommentRow = db.prepare(
    `INSERT INTO intake_comments (id, intake_id, author, body, created_at, external_id, origin,
       display_author, display_body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  /** Inserts a comment with its display text sanitized once, now; returns the display text. */
  const insertComment = {
    run(
      id: string,
      intakeId: string,
      author: string,
      body: string,
      createdAt: string,
      externalId: string | null,
      origin: "remote" | "local",
    ) {
      const display = { author: sanitizeForDisplay(author), body: sanitizeForDisplay(body) };
      insertCommentRow.run(
        id,
        intakeId,
        author,
        body,
        createdAt,
        externalId,
        origin,
        display.author,
        display.body,
      );
      return display;
    },
  };
  const replaceRemoteComments = (intakeId: string, comments: IssueComment[]) => {
    db.prepare("DELETE FROM intake_comments WHERE intake_id = ? AND origin = 'remote'").run(
      intakeId,
    );
    for (const c of comments) {
      insertComment.run(
        randomUUID(),
        intakeId,
        c.author,
        c.body,
        c.createdAt,
        c.externalId,
        "remote",
      );
    }
  };

  const api = {
    db,
    /** Strip HTML/scripts from untrusted ticket text for display. */
    sanitizeForDisplay,

    createManual(input: CreateManualInput): IntakeRecord {
      if (!input.title.trim())
        throw new SindriError("validation_failed", "intake title is required");
      requireProject(input.projectId);
      const attachments = input.attachments ?? [];
      if (attachments.length && !options.attachmentsDir) {
        throw new Error("attachmentsDir must be configured to store attachments");
      }
      const ts = iso();
      const snapshot: StoredSnapshot = {
        title: input.title,
        body: input.body,
        updated: ts,
        url: null,
        raw: { title: input.title, body: input.body },
      };
      const row: IntakeRow = {
        id: randomUUID(),
        project_id: input.projectId,
        source: "manual",
        external_id: null,
        external_url: null,
        title: input.title,
        raw_snapshot_json: JSON.stringify(snapshot),
        imported_at: ts,
        sync_state: "imported",
        permissions_json: JSON.stringify({ comments: false, attachments: attachments.length > 0 }),
        created_at: ts,
        pending_snapshot_json: null,
        display_title: sanitizeForDisplay(input.title),
        display_body: sanitizeForDisplay(input.body),
      };
      const blobs = attachments.map((a) => {
        const buf = typeof a.content === "string" ? Buffer.from(a.content) : Buffer.from(a.content);
        if (buf.byteLength > MAX_ATTACHMENT_BYTES)
          throw new SindriError("validation_failed", `attachment too large: ${a.name}`);
        const sha = createHash("sha256").update(buf).digest("hex");
        return { name: safeName(a.name), buf, sha, path: join(options.attachmentsDir ?? "", sha) };
      });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO intakes (id, project_id, source, external_id, external_url, title,
             raw_snapshot_json, imported_at, sync_state, permissions_json, created_at, pending_snapshot_json,
             display_title, display_body)
           VALUES (@id, @project_id, @source, @external_id, @external_url, @title,
             @raw_snapshot_json, @imported_at, @sync_state, @permissions_json, @created_at, @pending_snapshot_json,
             @display_title, @display_body)`,
        ).run(row);
        // Blob writes are not rolled back if the transaction fails; they are content-addressed,
        // so the worst case is an orphaned blob (harmless, reclaimable).
        if (blobs.length) mkdirSync(options.attachmentsDir as string, { recursive: true });
        for (const b of blobs) {
          writeFileSync(b.path, b.buf, { mode: 0o600 });
          db.prepare(
            `INSERT INTO intake_attachments (id, intake_id, name, bytes, sha256, path)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), row.id, b.name, b.buf.byteLength, b.sha, b.path);
        }
      })();
      return toRecord(row);
    },

    /** Import (or re-import) a ticket by URL through the first connector that handles it. */
    async importFromUrl(url: string, opts: ImportOptions): Promise<IntakeRecord> {
      requireProject(opts.projectId);
      const connector = connectors.find((c) => c.canHandle(url));
      if (!connector) throw new SindriError("no_connector", "no connector configured for this URL");
      const ref = connector.parseUrl(url);
      const wantComments = opts.importComments ?? true;
      const issue = await connector.fetchIssue(ref);
      const fetched =
        wantComments && connector.fetchComments ? await connector.fetchComments(ref) : undefined;
      const incoming = toStored(issue, fetched?.raw);
      const permissions: IntakePermissions = { comments: !!fetched, attachments: false };
      const ts = iso();

      const existing = db
        .prepare("SELECT * FROM intakes WHERE project_id = ? AND source = ? AND external_id = ?")
        .get(opts.projectId, connector.kind, issue.externalId) as IntakeRow | undefined;

      if (!existing) {
        const row: IntakeRow = {
          id: randomUUID(),
          project_id: opts.projectId,
          source: connector.kind,
          external_id: issue.externalId,
          external_url: ref.url,
          title: issue.title,
          raw_snapshot_json: JSON.stringify(incoming),
          imported_at: ts,
          sync_state: "imported",
          permissions_json: JSON.stringify(permissions),
          created_at: ts,
          pending_snapshot_json: null,
          display_title: sanitizeForDisplay(issue.title),
          display_body: sanitizeForDisplay(issue.body),
        };
        db.transaction(() => {
          db.prepare(
            `INSERT INTO intakes (id, project_id, source, external_id, external_url, title,
               raw_snapshot_json, imported_at, sync_state, permissions_json, created_at, pending_snapshot_json,
               display_title, display_body)
             VALUES (@id, @project_id, @source, @external_id, @external_url, @title,
               @raw_snapshot_json, @imported_at, @sync_state, @permissions_json, @created_at, @pending_snapshot_json,
               @display_title, @display_body)`,
          ).run(row);
          if (fetched) replaceRemoteComments(row.id, fetched.comments);
        })();
        return toRecord(row);
      }

      const current = JSON.parse(existing.raw_snapshot_json) as StoredSnapshot;
      if (
        current.updated === incoming.updated ||
        existing.acknowledged_remote_updated === incoming.updated
      ) {
        return toRecord(existing);
      }

      const localChanged = !!db
        .prepare(
          `SELECT 1 FROM intake_comments
           WHERE intake_id = ? AND origin = 'local' AND created_at > ? LIMIT 1`,
        )
        .get(existing.id, existing.imported_at);
      const state: SyncState = localChanged ? "conflict" : "stale";
      db.prepare(
        "UPDATE intakes SET sync_state = ?, pending_snapshot_json = ?, permissions_json = ? WHERE id = ?",
      ).run(
        state,
        JSON.stringify({ ...incoming, comments: fetched?.comments }),
        JSON.stringify(permissions),
        existing.id,
      );
      return toRecord(mustGet(existing.id));
    },

    /**
     * Resolve a stale/conflict intake: `remote` adopts the pending snapshot (and its
     * comments), `local` keeps the stored one. Either way the state returns to `imported`.
     */
    resolveSync(id: string, { take }: { take: "remote" | "local" }): IntakeRecord {
      const row = mustGet(id);
      db.transaction(() => {
        if (take === "remote" && row.pending_snapshot_json) {
          const pending = JSON.parse(row.pending_snapshot_json) as StoredSnapshot;
          const { comments, ...snapshot } = pending;
          db.prepare(
            `UPDATE intakes SET title = ?, raw_snapshot_json = ?, imported_at = ?, display_title = ?,
               display_body = ? WHERE id = ?`,
          ).run(
            snapshot.title,
            JSON.stringify(snapshot),
            iso(),
            sanitizeForDisplay(snapshot.title),
            sanitizeForDisplay(snapshot.body),
            id,
          );
          if (comments) replaceRemoteComments(id, comments);
        }
        if (take === "local" && row.pending_snapshot_json) {
          // Remember which remote version was declined so the next re-import does not
          // immediately flip back to stale/conflict.
          const pending = JSON.parse(row.pending_snapshot_json) as StoredSnapshot;
          db.prepare(
            "UPDATE intakes SET acknowledged_remote_updated = ?, imported_at = ? WHERE id = ?",
          ).run(pending.updated, iso(), id);
        }
        db.prepare(
          "UPDATE intakes SET sync_state = 'imported', pending_snapshot_json = NULL WHERE id = ?",
        ).run(id);
      })();
      return toRecord(mustGet(id));
    },

    /** Add a local annotation (counts as a local change for conflict detection). */
    annotate(id: string, { author, body }: { author: string; body: string }): IntakeCommentRecord {
      mustGet(id);
      const commentId = randomUUID();
      const createdAt = iso();
      const display = insertComment.run(commentId, id, author, body, createdAt, null, "local");
      return {
        id: commentId,
        intakeId: id,
        author,
        body,
        createdAt,
        externalId: null,
        origin: "local",
        display,
      };
    },

    get(id: string): IntakeRecord | undefined {
      const r = getRow(id);
      return r && toRecord(r);
    },
    list(projectId: string): IntakeRecord[] {
      return (
        db
          .prepare("SELECT * FROM intakes WHERE project_id = ? ORDER BY created_at, rowid")
          .all(projectId) as IntakeRow[]
      ).map(toRecord);
    },
    comments(id: string): IntakeCommentRecord[] {
      const rows = db
        .prepare(
          `SELECT id, intake_id AS intakeId, author, body, created_at AS createdAt,
                  external_id AS externalId, origin, display_author, display_body
           FROM intake_comments WHERE intake_id = ? ORDER BY created_at, rowid`,
        )
        .all(id) as (Omit<IntakeCommentRecord, "display"> & {
        display_author: string | null;
        display_body: string | null;
      })[];
      return rows.map(({ display_author, display_body, ...c }) => ({
        ...c,
        display: {
          author: display_author ?? sanitizeForDisplay(c.author),
          body: display_body ?? sanitizeForDisplay(c.body),
        },
      }));
    },
    /** Paths of the attachment blobs referenced by a project's intakes. */
    attachmentPaths(projectId: string): string[] {
      const rows = db
        .prepare(
          `SELECT DISTINCT a.path AS path FROM intake_attachments a
           JOIN intakes i ON i.id = a.intake_id WHERE i.project_id = ?`,
        )
        .all(projectId) as { path: string }[];
      return rows.map((r) => r.path);
    },

    /**
     * Delete the given blobs that no intake references any more (blobs are content-addressed
     * and may be shared across projects). Only files inside `attachmentsDir` are touched.
     */
    deleteUnreferencedBlobs(paths: readonly string[]): number {
      if (!options.attachmentsDir) return 0;
      const root = resolve(options.attachmentsDir) + sep;
      const used = db.prepare("SELECT 1 FROM intake_attachments WHERE path = ? LIMIT 1");
      let n = 0;
      for (const p of new Set(paths)) {
        const abs = resolve(p);
        if (!abs.startsWith(root) || used.get(p) || !existsSync(abs)) continue;
        rmSync(abs, { force: true });
        n++;
      }
      return n;
    },

    attachments(id: string): IntakeAttachment[] {
      return db
        .prepare(
          `SELECT id, intake_id AS intakeId, name, bytes, sha256, path
           FROM intake_attachments WHERE intake_id = ? ORDER BY rowid`,
        )
        .all(id) as IntakeAttachment[];
    },
    close: () => db.close(),
  };
  return api;
}

export type Intake = ReturnType<typeof openIntake>;
