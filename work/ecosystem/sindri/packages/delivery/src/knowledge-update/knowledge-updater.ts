import { randomUUID } from "node:crypto";
import { ensureQualitySchema } from "../schema.js";
import type { Knowledge, SqliteDatabase } from "@sindri/knowledge";
import { BROKKR_REPORT_KIND } from "../gates/brokkr-report.js";
import { CITATION } from "../report/citations.js";
import type { DeliveryReport } from "../report/delivery-report.js";

export type ProposalKind = "entry" | "decision";
export type ProposalStatus = "proposed" | "accepted" | "rejected";

export interface KnowledgeProposal {
  id: string;
  deliveryId: string;
  projectId: string;
  kind: ProposalKind;
  claim: string;
  /** ADR markdown for `decision` proposals. */
  body: string | null;
  /** Immutable `task_evidence` rows, recorded before the proposal. Never empty. */
  sourceRefs: { taskEvidenceId: string }[];
  confidence: number;
  status: ProposalStatus;
  entryId: string | null;
  decisionId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
}

export type KnowledgeUpdateErrorCode =
  | "unknown_delivery"
  | "not_delivered"
  | "source_required"
  | "unknown_source"
  | "unknown_proposal"
  | "not_proposed"
  | "not_an_entry";

export class KnowledgeUpdateError extends Error {
  override readonly name = "KnowledgeUpdateError";
  constructor(
    readonly code: KnowledgeUpdateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface KnowledgeUpdaterOptions {
  db: SqliteDatabase;
  knowledge: Pick<Knowledge, "projects" | "knowledge" | "evidence" | "decisions">;
  reports: { get(deliveryId: string): DeliveryReport | undefined };
  now?: () => Date;
}

interface ProposalRow {
  id: string;
  delivery_id: string;
  project_id: string;
  kind: ProposalKind;
  claim: string;
  body: string | null;
  source_refs_json: string;
  confidence: number;
  status: ProposalStatus;
  entry_id: string | null;
  decision_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
}

const toProposal = (r: ProposalRow): KnowledgeProposal => ({
  id: r.id,
  deliveryId: r.delivery_id,
  projectId: r.project_id,
  kind: r.kind,
  claim: r.claim,
  body: r.body,
  sourceRefs: JSON.parse(r.source_refs_json) as { taskEvidenceId: string }[],
  confidence: r.confidence,
  status: r.status,
  entryId: r.entry_id,
  decisionId: r.decision_id,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  reason: r.reason,
  createdAt: r.created_at,
});

interface EvidenceSource {
  kind: string;
  payload: unknown;
}

/** Every Mimir event/artifact id a delivery report rests on, with what it showed. */
export function evidenceCatalog(report: DeliveryReport): Map<string, EvidenceSource> {
  const out = new Map<string, EvidenceSource>();
  const add = (id: string | null, kind: string, payload: unknown) => {
    if (id && !out.has(id))
      out.set(id, { kind, payload: { deliveryId: report.id, ...(payload as object) } });
  };
  for (const t of report.tasks) {
    if (t.brokkr) {
      add(t.brokkr.reportArtifactId, BROKKR_REPORT_KIND, {
        planTaskId: t.planTaskId,
        verdict: t.brokkr.verdict,
        commitSha: t.brokkr.commitSha,
        checks: t.brokkr.checks,
      });
    }
  }
  for (const r of report.testResults) add(r.eventId, "test.run_completed", r);
  for (const r of report.reviews) {
    add(r.reviewArtifactId, "review", {
      planTaskId: r.planTaskId,
      verdict: r.verdict,
      findings: r.findings,
    });
  }
  for (const s of report.screenshots) add(s.artifactId, "screenshot", s);
  for (const f of report.changedFiles) {
    add(f.artifactId, "changed-files", {
      files: report.changedFiles.filter((x) => x.artifactId === f.artifactId).map((x) => x.path),
    });
  }
  for (const c of report.rollback.commits) add(c.eventId, "git.commit_observed", c);
  for (const s of report.summary.sentences) {
    for (const id of s.citations) add(id, "mimir.event", { citedBy: s.text });
  }
  return out;
}

const stripCitations = (text: string) =>
  text
    .replace(CITATION, "")
    .replace(/\s+([.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * Turns a delivered report into candidate project knowledge (F15). Evidence is copied into
 * immutable `task_evidence` rows first; every proposal cites them. Nothing becomes valid
 * knowledge until a human accepts it, or the project sets `autoAcceptKnowledge: true`.
 * ADR drafts stay pending `decision` proposals (audit M3); only a human `accept` records them as
 * accepted `decisions`. They are never auto-accepted.
 */
export class KnowledgeUpdater {
  readonly #db: SqliteDatabase;
  readonly #o: KnowledgeUpdaterOptions;
  readonly #now: () => Date;

  constructor(options: KnowledgeUpdaterOptions) {
    this.#o = options;
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    ensureQualitySchema(this.#db);
  }

  proposeEntries(deliveryId: string): KnowledgeProposal[] {
    const report = this.#delivered(deliveryId);
    const existing = this.list(deliveryId);
    if (existing.length > 0) return existing;
    const catalog = evidenceCatalog(report);

    const created = this.#db.transaction(() => {
      const out: KnowledgeProposal[] = [];
      const seen = new Set<string>();
      for (const s of report.summary.sentences) {
        const claim = stripCitations(s.text);
        if (!claim || seen.has(claim)) continue;
        seen.add(claim);
        out.push(this.#insertEntry(report, catalog, claim, s.citations, 0.6));
      }
      for (const r of [...report.testResults].reverse()) {
        if (!r.passed || !r.planTaskId || (r.exitCode !== null && r.exitCode !== 0)) continue;
        const claim = `Test command \`${r.command}\` passes on the delivered change (plan task ${r.planTaskId}).`;
        if (seen.has(claim)) continue;
        seen.add(claim);
        out.push(this.#insertEntry(report, catalog, claim, [r.eventId], 0.8));
      }
      for (const review of report.reviews) {
        const decisions = this.#reviewDecisions(review.reviewId);
        if (!review.reviewArtifactId) continue;
        for (const d of decisions) {
          out.push(this.#insertDecision(report, catalog, d, review.reviewArtifactId));
        }
      }
      return out;
    })();

    const settings = this.#o.knowledge.projects.get(report.projectId)?.settings ?? {};
    if (settings.autoAcceptKnowledge === true) {
      return created.map((p) => (p.kind === "entry" ? this.accept(p.id, "auto") : p));
    }
    return created;
  }

  /** A hand-written proposal; `refs` must be Mimir event/artifact ids from this delivery. */
  proposeEntry(
    deliveryId: string,
    input: { claim: string; refs: string[]; confidence?: number },
  ): KnowledgeProposal {
    const report = this.#delivered(deliveryId);
    if (input.refs.length === 0) {
      throw new KnowledgeUpdateError(
        "source_required",
        "a knowledge proposal needs at least one source",
      );
    }
    const catalog = evidenceCatalog(report);
    const unknown = input.refs.filter((r) => !catalog.has(r));
    if (unknown.length > 0) {
      throw new KnowledgeUpdateError(
        "unknown_source",
        `not evidence of delivery ${deliveryId}: ${unknown.join(", ")}`,
      );
    }
    return this.#db.transaction(() =>
      this.#insertEntry(report, catalog, input.claim.trim(), input.refs, input.confidence ?? 0.5),
    )();
  }

  /**
   * A human accepts a proposal: an entry becomes valid knowledge; an ADR draft becomes an
   * `accepted` decision with the actor as approver. Nothing else ever writes `decisions`.
   */
  accept(proposalId: string, actor: string): KnowledgeProposal {
    const row = this.#row(proposalId);
    if (row.status !== "proposed") {
      throw new KnowledgeUpdateError(
        "not_proposed",
        `proposal ${proposalId} is not proposed (it is ${row.status})`,
      );
    }
    return this.#db.transaction(() => {
      const at = this.#now().toISOString();
      if (row.kind === "decision") {
        const decision = this.#o.knowledge.decisions.record({
          projectId: row.project_id,
          title: row.claim,
          adrMarkdown: (row.body ?? "").replace(
            /^Status: proposed .*$/m,
            `Status: accepted by ${actor.replace(/\s+/g, " ").slice(0, 200)}`,
          ),
          status: "accepted",
          approver: actor,
        });
        this.#db
          .prepare(
            `UPDATE knowledge_proposals SET status = 'accepted', decision_id = ?, decided_by = ?, decided_at = ?
             WHERE id = ?`,
          )
          .run(decision.id, actor, at, proposalId);
        return toProposal(this.#row(proposalId));
      }
      const entry = this.#o.knowledge.knowledge.add({
        projectId: row.project_id,
        claim: row.claim,
        sourceRefs: JSON.parse(row.source_refs_json) as { taskEvidenceId: string }[],
        confidence: row.confidence,
        createdBy: actor,
      });
      this.#db
        .prepare(
          `UPDATE knowledge_proposals SET status = 'accepted', entry_id = ?, decided_by = ?, decided_at = ?
           WHERE id = ?`,
        )
        .run(entry.id, actor, at, proposalId);
      return toProposal(this.#row(proposalId));
    })();
  }

  reject(proposalId: string, actor: string, reason: string): KnowledgeProposal {
    const row = this.#row(proposalId);
    if (row.status !== "proposed") {
      throw new KnowledgeUpdateError(
        "not_proposed",
        `proposal ${proposalId} is not proposed (it is ${row.status})`,
      );
    }
    this.#db
      .prepare(
        `UPDATE knowledge_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ?
         WHERE id = ?`,
      )
      .run(actor, this.#now().toISOString(), reason, proposalId);
    return toProposal(this.#row(proposalId));
  }

  list(deliveryId: string): KnowledgeProposal[] {
    return (
      this.#db
        .prepare("SELECT * FROM knowledge_proposals WHERE delivery_id = ? ORDER BY rowid")
        .all(deliveryId) as ProposalRow[]
    ).map(toProposal);
  }

  /** Task evidence id recorded for a Mimir ref of this delivery, if any. */
  evidenceFor(deliveryId: string, refId: string): string | undefined {
    return (
      this.#db
        .prepare(
          "SELECT task_evidence_id FROM delivery_evidence WHERE delivery_id = ? AND ref_id = ?",
        )
        .get(deliveryId, refId) as { task_evidence_id: string } | undefined
    )?.task_evidence_id;
  }

  // -------------------------------------------------------------------------------------------

  #delivered(deliveryId: string): DeliveryReport {
    const report = this.#o.reports.get(deliveryId);
    if (!report)
      throw new KnowledgeUpdateError("unknown_delivery", `unknown delivery ${deliveryId}`);
    if (report.status !== "delivered_pending_merge") {
      throw new KnowledgeUpdateError(
        "not_delivered",
        `delivery ${deliveryId} is ${report.status}; knowledge is proposed after delivered_pending_merge`,
      );
    }
    return report;
  }

  #row(id: string): ProposalRow {
    const r = this.#db.prepare("SELECT * FROM knowledge_proposals WHERE id = ?").get(id) as
      ProposalRow | undefined;
    if (!r) throw new KnowledgeUpdateError("unknown_proposal", `unknown proposal ${id}`);
    return r;
  }

  /** Records (once per delivery and ref) the immutable task evidence row for a Mimir ref. */
  #evidence(report: DeliveryReport, catalog: Map<string, EvidenceSource>, refId: string): string {
    const known = this.evidenceFor(report.id, refId);
    if (known) return known;
    const source = catalog.get(refId);
    if (!source) throw new KnowledgeUpdateError("unknown_source", `no evidence ${refId}`);
    const row = this.#o.knowledge.evidence.record({
      projectId: report.projectId,
      externalRef: `mimir:${refId}`,
      kind: source.kind,
      payload: source.payload,
    });
    this.#db
      .prepare(
        "INSERT INTO delivery_evidence (delivery_id, project_id, ref_id, task_evidence_id) VALUES (?, ?, ?, ?)",
      )
      .run(report.id, report.projectId, refId, row.id);
    return row.id;
  }

  #insertEntry(
    report: DeliveryReport,
    catalog: Map<string, EvidenceSource>,
    claim: string,
    refs: string[],
    confidence: number,
  ): KnowledgeProposal {
    const sourceRefs = [...new Set(refs)].map((r) => ({
      taskEvidenceId: this.#evidence(report, catalog, r),
    }));
    return this.#insert({
      report,
      kind: "entry",
      claim,
      body: null,
      sourceRefs,
      confidence,
      decisionId: null,
    });
  }

  #insertDecision(
    report: DeliveryReport,
    catalog: Map<string, EvidenceSource>,
    d: { title: string; context?: string | undefined; decision: string },
    reviewArtifactId: string,
  ): KnowledgeProposal {
    const evidenceId = this.#evidence(report, catalog, reviewArtifactId);
    const adr = [
      `# ${d.title}`,
      "",
      "Status: proposed (drafted by Sindri from an independent review; needs human acceptance)",
      "",
      "## Context",
      "",
      d.context ?? "Not stated.",
      "",
      "## Decision",
      "",
      d.decision,
      "",
      "## Sources",
      "",
      `- review artifact ${reviewArtifactId} (task evidence ${evidenceId}), delivery ${report.id}`,
      "",
    ].join("\n");
    // A pending proposal only (audit M3): reviewer text never enters `decisions` directly.
    return this.#insert({
      report,
      kind: "decision",
      claim: d.title,
      body: adr,
      sourceRefs: [{ taskEvidenceId: evidenceId }],
      confidence: 0.5,
      decisionId: null,
    });
  }

  #reviewDecisions(reviewId: string) {
    const row = this.#db
      .prepare("SELECT decisions_json FROM reviews WHERE id = ?")
      .get(reviewId) as { decisions_json: string } | undefined;
    return row
      ? (JSON.parse(row.decisions_json) as { title: string; context?: string; decision: string }[])
      : [];
  }

  #insert(p: {
    report: DeliveryReport;
    kind: ProposalKind;
    claim: string;
    body: string | null;
    sourceRefs: { taskEvidenceId: string }[];
    confidence: number;
    decisionId: string | null;
  }): KnowledgeProposal {
    const row: ProposalRow = {
      id: `kpr_${randomUUID()}`,
      delivery_id: p.report.id,
      project_id: p.report.projectId,
      kind: p.kind,
      claim: p.claim,
      body: p.body,
      source_refs_json: JSON.stringify(p.sourceRefs),
      confidence: p.confidence,
      status: "proposed",
      entry_id: null,
      decision_id: p.decisionId,
      decided_by: null,
      decided_at: null,
      reason: null,
      created_at: this.#now().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, body, source_refs_json,
           confidence, status, entry_id, decision_id, decided_by, decided_at, reason, created_at)
         VALUES (@id, @delivery_id, @project_id, @kind, @claim, @body, @source_refs_json, @confidence,
           @status, @entry_id, @decision_id, @decided_by, @decided_at, @reason, @created_at)`,
      )
      .run(row);
    return toProposal(row);
  }
}
