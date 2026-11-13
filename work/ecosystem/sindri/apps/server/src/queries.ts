import type { SqliteDatabase } from "@sindri/knowledge";

/**
 * Read-only queries over the delivery package's tables that `DeliveryLoop` does not expose:
 * executions by project (executions only know their plan), and event rows by insertion order
 * (for SSE ids and Last-Event-ID resume). Nothing here writes.
 */
export interface ExecutionSummaryRow {
  id: string;
  planId: string;
  planVersion: number;
  projectId: string;
  status: string;
  mimirMissionId: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface EventRow {
  seq: number;
  id: string;
  mimirEventId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
}

export function executionsByProject(db: SqliteDatabase, projectId: string): ExecutionSummaryRow[] {
  return db
    .prepare(
      `SELECT e.id, e.plan_id AS planId, e.plan_version AS planVersion, p.project_id AS projectId,
              e.status, e.mimir_mission_id AS mimirMissionId, e.created_at AS createdAt,
              e.finished_at AS finishedAt
       FROM executions e JOIN plans p ON p.id = e.plan_id
       WHERE p.project_id = ? ORDER BY e.created_at DESC, e.rowid DESC`,
    )
    .all(projectId) as ExecutionSummaryRow[];
}

/** The project of an execution, through its plan (null when the plan is gone). */
export function projectOfExecution(db: SqliteDatabase, executionId: string): string | null {
  const r = db
    .prepare(
      "SELECT p.project_id AS projectId FROM executions e JOIN plans p ON p.id = e.plan_id WHERE e.id = ?",
    )
    .get(executionId) as { projectId: string } | undefined;
  return r?.projectId ?? null;
}

/** Sequence number of an event row (for Last-Event-ID); 0 when unknown. */
export function eventSeq(db: SqliteDatabase, executionId: string, eventId: string): number {
  const r = db
    .prepare("SELECT rowid AS seq FROM execution_events WHERE execution_id = ? AND id = ?")
    .get(executionId, eventId) as { seq: number } | undefined;
  return r?.seq ?? 0;
}

export function eventsAfter(
  db: SqliteDatabase,
  executionId: string,
  afterSeq: number,
  limit = 500,
): EventRow[] {
  return (
    db
      .prepare(
        `SELECT rowid AS seq, id, mimir_event_id, type, payload_json, occurred_at
         FROM execution_events WHERE execution_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(executionId, afterSeq, limit) as {
      seq: number;
      id: string;
      mimir_event_id: string;
      type: string;
      payload_json: string;
      occurred_at: string;
    }[]
  ).map((r) => ({
    seq: r.seq,
    id: r.id,
    mimirEventId: r.mimir_event_id,
    type: r.type,
    payload: JSON.parse(r.payload_json) as unknown,
    occurredAt: r.occurred_at,
  }));
}

/** Every execution with its status (startup resume). */
export function executionStatuses(db: SqliteDatabase): { id: string; status: string }[] {
  return db.prepare("SELECT id, status FROM executions ORDER BY created_at").all() as {
    id: string;
    status: string;
  }[];
}

/** The state of a delivery's work, for lists (see `deliveryWork`). */
export interface DeliveryWork {
  title: string | null;
  /** Research only: the accept or reject decision. */
  decision: "accepted" | "rejected" | null;
  /** PR reviews only: the review was posted to GitHub. */
  posted: boolean;
  postedUrl: string | null;
  /** PR reviews only: the verdict that would be (or was) posted; null for other kinds. */
  verdict: string | null;
  prUrl: string | null;
  /** Every plan task's latest gate evaluation passed (true), one failed (false), or not all evaluated (null). */
  gatePassed: boolean | null;
}

type PlanBits = {
  specId?: string;
  tasks?: { id: string }[];
  work?: {
    kind?: "change" | "research" | "pr_review";
    research?: { question?: string };
    prReview?: { title?: string; url?: string };
  };
};

/**
 * Work kind and a summary of each delivery's state from stored rows only (no Mimir call, no
 * report build): the stored plan, gate evaluations, document decisions, review drafts and posts.
 * One query per table for all the given executions; each stored plan is parsed once.
 */
export function deliveriesWork(
  db: SqliteDatabase,
  executionIds: readonly string[],
): Map<string, { workKind: "change" | "research" | "pr_review"; work: DeliveryWork }> {
  const out = new Map<
    string,
    { workKind: "change" | "research" | "pr_review"; work: DeliveryWork }
  >();
  if (executionIds.length === 0) return out;
  const tables = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
           ('gate_evaluations', 'document_decisions', 'review_posts', 'review_drafts', 'specifications')`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  const ids = JSON.stringify(executionIds);
  const IN = "IN (SELECT value FROM json_each(?))";
  const execs = db
    .prepare(`SELECT id, plan_id, plan_version, plan_json FROM executions WHERE id ${IN}`)
    .all(ids) as { id: string; plan_id: string; plan_version: number; plan_json: string }[];
  const gates = new Map<string, Map<string, boolean>>();
  if (tables.has("gate_evaluations"))
    for (const g of db
      .prepare(
        `SELECT execution_id, plan_task_id, passed FROM gate_evaluations WHERE execution_id ${IN}
         ORDER BY rowid`,
      )
      .all(ids) as { execution_id: string; plan_task_id: string; passed: number }[]) {
      const m = gates.get(g.execution_id) ?? new Map<string, boolean>();
      m.set(g.plan_task_id, g.passed === 1);
      gates.set(g.execution_id, m);
    }
  const decisions = new Map<string, "accepted" | "rejected">();
  if (tables.has("document_decisions"))
    for (const d of db
      .prepare(`SELECT execution_id, decision FROM document_decisions WHERE execution_id ${IN}`)
      .all(ids) as { execution_id: string; decision: "accepted" | "rejected" }[])
      decisions.set(d.execution_id, d.decision);
  const posts = new Map<string, string>();
  if (tables.has("review_posts"))
    for (const p of db
      .prepare(`SELECT execution_id, html_url FROM review_posts WHERE execution_id ${IN}`)
      .all(ids) as { execution_id: string; html_url: string }[])
      posts.set(p.execution_id, p.html_url);
  const verdicts = new Map<string, string>();
  if (tables.has("review_drafts"))
    for (const d of db
      .prepare(
        `SELECT execution_id, verdict FROM review_drafts r WHERE execution_id ${IN}
         AND version = (SELECT MAX(version) FROM review_drafts x WHERE x.execution_id = r.execution_id)`,
      )
      .all(ids) as { execution_id: string; verdict: string }[])
      verdicts.set(d.execution_id, d.verdict);
  const plans = new Map<string, PlanBits>();
  const specTitle = tables.has("specifications")
    ? db.prepare("SELECT title FROM specifications WHERE id = ?")
    : null;
  for (const e of execs) {
    const key = `${e.plan_id}\0${e.plan_version}`;
    let plan = plans.get(key);
    if (!plan) {
      try {
        plan = JSON.parse(e.plan_json) as PlanBits;
      } catch {
        plan = {};
      }
      plans.set(key, plan);
    }
    const workKind = plan.work?.kind ?? "change";
    const latest = gates.get(e.id) ?? new Map<string, boolean>();
    const taskIds = (plan.tasks ?? []).map((t) => t.id);
    const gatePassed = [...latest.values()].includes(false)
      ? false
      : taskIds.length > 0 && taskIds.every((id) => latest.get(id) === true)
        ? true
        : null;
    const work: DeliveryWork = {
      title: null,
      decision: null,
      posted: false,
      postedUrl: null,
      verdict: null,
      prUrl: null,
      gatePassed,
    };
    if (workKind === "research") {
      work.title = plan.work?.research?.question?.split("\n")[0]?.slice(0, 300) ?? null;
      work.decision = decisions.get(e.id) ?? null;
    } else if (workKind === "pr_review") {
      work.title = plan.work?.prReview?.title?.slice(0, 300) ?? null;
      work.prUrl = plan.work?.prReview?.url ?? null;
      work.posted = posts.has(e.id);
      work.postedUrl = posts.get(e.id) ?? null;
      // Without an operator edit the draft is the agent's review with the verdict `comment`.
      work.verdict = verdicts.get(e.id) ?? "comment";
    } else if (plan.specId && specTitle) {
      work.title = (specTitle.get(plan.specId) as { title: string } | undefined)?.title ?? null;
    }
    out.set(e.id, { workKind, work });
  }
  return out;
}
