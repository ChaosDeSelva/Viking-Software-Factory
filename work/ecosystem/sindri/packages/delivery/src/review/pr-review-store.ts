import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@sindri/knowledge";
import { ensureQualitySchema } from "../schema.js";
import type { FindingEdit, PrReviewVerdict, StoredDraft } from "./pr-review.js";

/** A review posted to GitHub; one per execution. */
export interface ReviewPost {
  executionId: string;
  /** Null for a recovered post that matched no recorded attempt. */
  draftVersion: number | null;
  reviewId: number;
  htmlUrl: string;
  commitId: string;
  payloadSha256: string;
  actor: string;
  postedAt: string;
  /** Found on GitHub by its marker after a failed or timed-out POST. */
  recovered: boolean;
}

/** One POST of a review, recorded before it is sent. */
export interface ReviewPostAttempt {
  id: string;
  draftVersion: number;
  payloadSha256: string;
  startedAt: string;
}

interface DraftRow {
  version: number;
  verdict: PrReviewVerdict;
  summary: string;
  findings_json: string;
  actor: string;
  created_at: string;
}

/**
 * Operator drafts of a PR review (append-only versions; the agent's review is never changed) and
 * the record of the review posted from them.
 */
export class PrReviewStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    ensureQualitySchema(db);
  }

  latestDraft(executionId: string): StoredDraft | null {
    const r = this.#db
      .prepare(
        `SELECT version, verdict, summary, findings_json, actor, created_at FROM review_drafts
         WHERE execution_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(executionId) as DraftRow | undefined;
    return r
      ? {
          version: r.version,
          verdict: r.verdict,
          summary: r.summary,
          findings: JSON.parse(r.findings_json) as FindingEdit[],
          actor: r.actor,
          createdAt: r.created_at,
        }
      : null;
  }

  saveDraft(
    executionId: string,
    projectId: string,
    draft: Pick<StoredDraft, "verdict" | "summary" | "findings">,
    actor: string,
  ): StoredDraft {
    return this.#db.transaction(() => {
      const version = (this.latestDraft(executionId)?.version ?? 0) + 1;
      const createdAt = this.#now().toISOString();
      this.#db
        .prepare(
          `INSERT INTO review_drafts (execution_id, version, project_id, verdict, summary,
             findings_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          executionId,
          version,
          projectId,
          draft.verdict,
          draft.summary,
          JSON.stringify(draft.findings),
          actor,
          createdAt,
        );
      return { ...draft, version, actor, createdAt };
    })();
  }

  posted(executionId: string): ReviewPost | null {
    const r = this.#db
      .prepare("SELECT * FROM review_posts WHERE execution_id = ?")
      .get(executionId) as
      | {
          execution_id: string;
          draft_version: number | null;
          review_id: number;
          html_url: string;
          commit_id: string;
          payload_sha256: string;
          actor: string;
          posted_at: string;
          recovered: number;
        }
      | undefined;
    return r
      ? {
          executionId: r.execution_id,
          draftVersion: r.draft_version,
          reviewId: r.review_id,
          htmlUrl: r.html_url,
          commitId: r.commit_id,
          payloadSha256: r.payload_sha256,
          actor: r.actor,
          postedAt: r.posted_at,
          recovered: r.recovered === 1,
        }
      : null;
  }

  /** Records a POST about to be sent. */
  recordAttempt(
    executionId: string,
    projectId: string,
    attempt: { draftVersion: number; payloadSha256: string },
  ): ReviewPostAttempt {
    const row = {
      id: `rpa_${randomUUID()}`,
      draftVersion: attempt.draftVersion,
      payloadSha256: attempt.payloadSha256,
      startedAt: this.#now().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO review_post_attempts (id, execution_id, project_id, draft_version,
           payload_sha256, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, executionId, projectId, row.draftVersion, row.payloadSha256, row.startedAt);
    return row;
  }

  /** The latest recorded attempt whose payload hash starts with `hashPrefix`. */
  attemptByHash(executionId: string, hashPrefix: string): ReviewPostAttempt | null {
    if (!/^[0-9a-f]{1,64}$/.test(hashPrefix)) return null;
    const r = this.#db
      .prepare(
        `SELECT id, draft_version, payload_sha256, started_at FROM review_post_attempts
         WHERE execution_id = ? AND substr(payload_sha256, 1, ?) = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(executionId, hashPrefix.length, hashPrefix) as
      { id: string; draft_version: number; payload_sha256: string; started_at: string } | undefined;
    return r
      ? {
          id: r.id,
          draftVersion: r.draft_version,
          payloadSha256: r.payload_sha256,
          startedAt: r.started_at,
        }
      : null;
  }

  /** Records a posted review; false when one was already recorded (the first one stays). */
  recordPost(
    projectId: string,
    post: Omit<ReviewPost, "postedAt" | "recovered"> & { recovered?: boolean },
  ): ReviewPost {
    this.#db
      .prepare(
        `INSERT INTO review_posts (execution_id, project_id, draft_version, review_id, html_url,
           commit_id, payload_sha256, actor, posted_at, recovered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id) DO NOTHING`,
      )
      .run(
        post.executionId,
        projectId,
        post.draftVersion,
        post.reviewId,
        post.htmlUrl,
        post.commitId,
        post.payloadSha256,
        post.actor,
        this.#now().toISOString(),
        post.recovered ? 1 : 0,
      );
    return this.posted(post.executionId) as ReviewPost;
  }
}
