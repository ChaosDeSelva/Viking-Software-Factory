import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqliteDatabase } from "./db.js";
import { SindriError } from "./errors.js";
import { containsSecret, redactSecrets, PRIVATE_TOOLING, LESSON_REFERENCE } from "./secrets.js";
import type { DecisionStatus } from "./types.js";

export const DesignProposalSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  decision: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(1000),
  supersedesId: z.string().trim().min(1).max(200).optional(),
});
export type DesignProposal = z.infer<typeof DesignProposalSchema>;
type Transition = { status: DecisionStatus; actor: string; at: string; seq: number };
export interface ProjectDecision {
  id: string;
  projectId: string;
  title: string;
  decision: string;
  rationale: string;
  source: string;
  actor: string;
  createdAt: string;
  status: DecisionStatus;
  supersedesId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  exportBlockedReason: string | null;
  history: Transition[];
}

const clean = (value: string) =>
  redactSecrets(value.normalize("NFC"))
    .text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
const markdownText = (value: string) =>
  clean(value)
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function requireProject(db: SqliteDatabase, projectId: string) {
  if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId))
    throw new SindriError("not_found", "project not found");
}

function requireAccepted(db: SqliteDatabase, projectId: string, id: string) {
  const row = db
    .prepare("SELECT status FROM decisions WHERE project_id = ? AND id = ?")
    .get(projectId, id) as { status: string } | undefined;
  if (!row) throw new SindriError("not_found", "referenced decision not found");
  if (row.status !== "accepted")
    throw new SindriError("invalid_state", "only a current accepted decision can be superseded");
}

function transition(
  db: SqliteDatabase,
  id: string,
  status: DecisionStatus,
  actor: string,
  at: string,
) {
  db.prepare(
    "INSERT INTO decision_transitions (decision_id, status, actor, at) VALUES (?, ?, ?, ?)",
  ).run(id, status, actor, at);
}

export function proposeProjectDecision(
  db: SqliteDatabase,
  projectId: string,
  input: DesignProposal,
  actor: string,
  at = new Date().toISOString(),
): string {
  const p = DesignProposalSchema.parse(input);
  return db
    .transaction(() => {
      requireProject(db, projectId);
      if (p.supersedesId) requireAccepted(db, projectId, p.supersedesId);
      const title = clean(p.title);
      const statement = clean(p.decision);
      const rationale = clean(p.rationale);
      const source = clean(p.source);
      if (![title, statement, rationale, source].every(Boolean))
        throw new SindriError(
          "validation_failed",
          "title, decision, rationale and source require visible text",
        );
      const id = `dec_${randomUUID()}`;
      const adr = `## Context\n\n${rationale}\n\n## Decision\n\n${statement}\n\n## Sources\n\n${source}`;
      db.prepare(
        "INSERT INTO decisions (id, project_id, title, adr_markdown, status, created_at) VALUES (?, ?, ?, ?, 'proposed', ?)",
      ).run(id, projectId, title, adr, at);
      db.prepare(
        "INSERT INTO decision_details (decision_id, statement, rationale, source, actor, supersedes_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, statement, rationale, source, actor, p.supersedesId ?? null);
      transition(db, id, "proposed", actor, at);
      return id;
    })
    .immediate();
}

export function decideProjectDecision(
  db: SqliteDatabase,
  projectId: string,
  id: string,
  status: "accepted" | "rejected",
  actor: string,
  at = new Date().toISOString(),
): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `SELECT d.status, m.supersedes_id AS target FROM decisions d
      LEFT JOIN decision_details m ON m.decision_id = d.id WHERE d.project_id = ? AND d.id = ?`,
      )
      .get(projectId, id) as { status: DecisionStatus; target: string | null } | undefined;
    if (!row) throw new SindriError("not_found", "design proposal not found");
    if (row.status !== "proposed")
      throw new SindriError("invalid_state", "design proposal already decided");
    if (status === "accepted" && row.target) {
      requireAccepted(db, projectId, row.target);
      db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?").run(row.target);
      transition(db, row.target, "superseded", actor, at);
    }
    db.prepare("UPDATE decisions SET status = ?, approver = ? WHERE id = ?").run(status, actor, id);
    transition(db, id, status, actor, at);
  }).immediate();
}

type DecisionRow = Omit<
  ProjectDecision,
  | "history"
  | "decidedBy"
  | "decidedAt"
  | "decision"
  | "actor"
  | "rationale"
  | "source"
  | "exportBlockedReason"
> & {
  body: string;
  approver: string | null;
  decision: string | null;
  actor: string | null;
  rationale: string | null;
  source: string | null;
};

function adrSection(markdown: string, name: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`);
  if (first < 0) return undefined;
  let end = first + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
  return (
    lines
      .slice(first + 1, end)
      .join("\n")
      .trim() || undefined
  );
}

function legacyStatement(body: string, title: string): string {
  return (
    adrSection(body, "decision") ??
    (/^#{1,3} |^(status|approver|sources?|actor):/im.test(body) ? title : body)
  );
}

/** Prompt context includes only accepted rules, without their private sources or actor history. */
export function acceptedDecisionContext(
  db: SqliteDatabase,
  projectId: string,
  keywords: readonly string[],
) {
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.adr_markdown AS body, m.statement, m.rationale
    FROM decisions d LEFT JOIN decision_details m ON m.decision_id=d.id
    WHERE d.project_id=? AND d.status='accepted' ORDER BY d.created_at DESC,d.rowid DESC`,
    )
    .all(projectId) as {
    id: string;
    title: string;
    body: string;
    statement: string | null;
    rationale: string | null;
  }[];
  return rows
    .flatMap((row) => {
      const statement = row.statement ?? legacyStatement(row.body, row.title);
      const why = row.rationale ?? adrSection(row.body, "context");
      const text = why ? statement + "\n" + why : statement;
      if (containsSecret(row.title + "\n" + text)) return [];
      const title = clean(row.title);
      const body = clean(text);
      const searchable = (title + " " + body).toLowerCase();
      return [
        {
          id: row.id,
          title,
          text: body.slice(0, 2000),
          score: keywords.filter((k) => searchable.includes(k)).length,
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function readProjectDecisions(
  db: SqliteDatabase,
  projectId: string,
  acceptedOnly: boolean,
): ProjectDecision[] {
  return db.transaction(() => {
    requireProject(db, projectId);
    const rows = db
      .prepare(
        `SELECT d.id, d.project_id AS projectId, d.title, d.adr_markdown AS body,
        d.status, d.approver, d.created_at AS createdAt, m.statement AS decision, m.rationale,
        m.source, m.actor, m.supersedes_id AS supersedesId
      FROM decisions d LEFT JOIN decision_details m ON m.decision_id = d.id
      WHERE d.project_id = ? ${acceptedOnly ? "AND d.status IN ('accepted','superseded')" : ""}
      ORDER BY d.created_at, d.rowid`,
      )
      .all(projectId) as DecisionRow[];
    const histories = new Map<string, Transition[]>();
    for (const event of db
      .prepare(
        `SELECT t.decision_id AS id,t.status,t.actor,t.at,t.seq FROM decision_transitions t
      JOIN decisions d ON t.decision_id=d.id WHERE d.project_id=? ORDER BY t.seq`,
      )
      .all(projectId) as (Transition & { id: string })[]) {
      const items = histories.get(event.id) ?? [];
      items.push({ status: event.status, actor: clean(event.actor), at: event.at, seq: event.seq });
      histories.set(event.id, items);
    }
    return rows.map((row) => {
      const legacy = row.decision === null;
      const history = histories.get(row.id) ?? [];
      if (legacy)
        history.unshift({
          status: history.length
            ? history[0]!.status === "superseded"
              ? "accepted"
              : "proposed"
            : row.status,
          actor:
            history[0] && history[0].status !== "superseded"
              ? "Unrecorded"
              : clean(row.approver ?? "Unrecorded"),
          at: row.createdAt,
          seq: 0,
        });
      const disposition = history.findLast(
        (x) => x.status === "accepted" || x.status === "rejected",
      );
      const title = clean(row.title);
      const decision = clean(row.decision ?? legacyStatement(row.body, row.title));
      const rationale = clean(row.rationale ?? adrSection(row.body, "context") ?? "Unrecorded");
      const blocked = Object.entries({ title, statement: decision, rationale }).find(
        ([, text]) => !publishable(text),
      );
      return {
        id: row.id,
        projectId,
        title,
        status: row.status,
        createdAt: row.createdAt,
        decision,
        rationale,
        exportBlockedReason: blocked ? `The ${blocked[0]} contains a private reference.` : null,
        source: clean(row.source ?? adrSection(row.body, "sources") ?? `ADR ${row.id}`),
        actor: clean(row.actor ?? history[0]?.actor ?? "Unrecorded"),
        supersedesId: row.supersedesId,
        decidedBy: disposition?.actor ?? null,
        decidedAt: disposition?.at ?? null,
        history,
      };
    });
  })();
}

/** Private Markdown keeps the actor and evidence attached to each dated transition. */
export function projectDecisionLog(db: SqliteDatabase, projectId: string) {
  const entries = readProjectDecisions(db, projectId, false);
  const lines = ["## Decision log", ""];
  const events = orderedEvents(entries);
  for (const [i, { entry, event, replacement }] of events.entries()) {
    const why =
      event.status === "superseded" && replacement ? replacement.rationale : entry.rationale;
    lines.push(
      `${i + 1}. ${event.at.slice(0, 10)} · ${event.status} · **${markdownText(entry.title)}** — ${markdownText(entry.decision)}`,
      `   - Why: ${markdownText(why)}`,
      `   - Recorded by: ${markdownText(event.actor)}`,
      `   - Source: ${markdownText(entry.source)}`,
      `   - ID: ${markdownText(entry.id)}`,
    );
    if (entry.exportBlockedReason) lines.push(`   - Patch export: ${entry.exportBlockedReason}`);
    if (entry.supersedesId) lines.push(`   - Supersedes: ${markdownText(entry.supersedesId)}`);
    if (replacement && event.status === "superseded")
      lines.push(`   - Replaced by: ${markdownText(replacement.title)}`);
    lines.push("");
  }
  return { entries, markdown: lines.join("\n") };
}

function orderedEvents(entries: readonly ProjectDecision[]) {
  const replacements = new Map(
    entries
      .filter((e) => e.supersedesId && (e.status === "accepted" || e.status === "superseded"))
      .map((e) => [e.supersedesId, e]),
  );
  return entries
    .flatMap((entry) =>
      entry.history.map((event) => ({ entry, event, replacement: replacements.get(entry.id) })),
    )
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.event.seq - b.event.seq);
}

const PRIVATE_REFERENCE =
  /\b(?:fg|chunk|intake|knowledge|lesson|spec|decision|artifact|evidence):\S+|(?:\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|\bfile:\/\/|(?:\/Users|\/home|\/private\/var|\/var\/folders)\/|~\/)|(?:^|\s)[A-Za-z]:\\Users\\/i;

const EMAIL_ADDRESS =
  /[\p{L}\p{N}_%+'-]@(?:[\p{L}\p{N}-]+\.)+(?:xn--[a-z0-9-]+|\p{L}{2,})(?![\p{L}\p{N}-])/iu;

function publishable(text: string): boolean {
  return (
    !PRIVATE_TOOLING.test(text) &&
    !LESSON_REFERENCE.test(text) &&
    !PRIVATE_REFERENCE.test(text) &&
    !EMAIL_ADDRESS.test(text)
  );
}

/** Delivery copies accepted events into a project repository, omitting private evidence and identities. */
export function projectDecisionLogSnapshot(
  db: SqliteDatabase,
  projectId: string,
  through?: string,
): { id: string; markdown: string }[] {
  const installed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_details'")
    .get();
  if (!installed) return [];
  const entries = readProjectDecisions(db, projectId, true);
  const titles = new Map(entries.map((e) => [e.id, e.title]));
  const cutoff = through ? Date.parse(through) : undefined;
  return orderedEvents(entries).flatMap(({ entry, event, replacement }) => {
    if (cutoff !== undefined && Date.parse(event.at) > cutoff) return [];
    if (event.status !== "accepted" && event.status !== "superseded") return [];
    if (entry.exportBlockedReason) return [];
    const why =
      event.status === "superseded" && replacement
        ? publishable(replacement.rationale)
          ? replacement.rationale
          : "Unrecorded"
        : entry.rationale;
    const related =
      event.status === "superseded" ? replacement?.title : titles.get(entry.supersedesId ?? "");
    const relation =
      related && publishable(related)
        ? ` ${event.status === "superseded" ? "Replaced by" : "Replaces"}: ${markdownText(related)}.`
        : "";
    return [
      {
        id: `${entry.id}:${event.status}`,
        markdown:
          `- ${event.at.slice(0, 10)} · ${event.status} · **${markdownText(entry.title)}** — ${markdownText(entry.decision)}` +
          (why === "Unrecorded" ? "" : ` Why: ${markdownText(why)}`) +
          relation,
      },
    ];
  });
}
