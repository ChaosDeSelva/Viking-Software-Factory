import type { FakeResponder } from "@sindri/director";
import { openKnowledge } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { approveReview, IMPL, QA, scenario } from "../report/scenario.test-helpers.js";
import { KnowledgeUpdateError, KnowledgeUpdater } from "./knowledge-updater.js";

async function delivered(
  settings: Record<string, unknown> = {},
  opts: { deliver?: boolean; responder?: FakeResponder } = {},
) {
  const s = await scenario(opts.responder ? { responder: opts.responder } : {});
  const k = openKnowledge(s.db);
  const project = k.projects.create({ name: "app", repoPath: "/repos/app", settings });
  s.w.plan.projectId = project.id;
  await approveReview(s);
  await s.gates.evaluate(s.w.executionId, IMPL);
  await s.gates.evaluate(s.w.executionId, QA);
  const deliveryId =
    opts.deliver === false
      ? (await s.reports.build(s.w.executionId)).id
      : (await s.reports.requestPr(s.w.executionId)).deliveryId;
  const updater = new KnowledgeUpdater({
    db: s.db,
    knowledge: k,
    reports: s.reports,
    now: () => new Date("2026-10-14T13:00:00.000Z"),
  });
  return { s, k, project, deliveryId, updater };
}

describe("KnowledgeUpdater.proposeEntries", () => {
  it("only runs after delivered_pending_merge", async () => {
    const { updater, deliveryId } = await delivered({}, { deliver: false });
    expect(() => updater.proposeEntries(deliveryId)).toThrow(KnowledgeUpdateError);
    expect(() => updater.proposeEntries("dlv_nope")).toThrow(/unknown delivery/);
  });

  it("records immutable task evidence first, then proposes sourced entries; nothing becomes valid yet", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const proposals = updater.proposeEntries(deliveryId);
    const entries = proposals.filter((p) => p.kind === "entry");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((p) => p.status === "proposed" && p.sourceRefs.length > 0)).toBe(true);
    expect(entries.map((p) => p.claim)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^The backend change passed Brokkr verification\.?$/),
        "Test command `pnpm test` passes on the delivered change (plan task implement-backend).",
      ]),
    );
    const evidence = k.evidence.list(project.id);
    for (const p of entries) {
      for (const ref of p.sourceRefs) {
        expect(evidence.map((e) => e.id)).toContain(ref.taskEvidenceId);
      }
    }
    expect(evidence[0]!.externalRef).toMatch(/^mimir:/);
    expect(() =>
      k.db.prepare("UPDATE task_evidence SET kind = 'x' WHERE id = ?").run(evidence[0]!.id),
    ).toThrow(/immutable/);
    expect(k.knowledge.listValid(project.id)).toEqual([]);
  });

  it("drafts ADRs from review decisions as pending proposals, never as decisions (audit M3)", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const proposals = updater.proposeEntries(deliveryId);
    const adr = proposals.find((p) => p.kind === "decision")!;
    expect(adr).toMatchObject({
      status: "proposed",
      claim: "Compare endpoint is read-only",
      decisionId: null,
    });
    expect(adr.body).toContain("GET /compare never writes");
    expect(adr.body).toMatch(/task evidence [0-9a-f-]{36}/);
    // Nothing reaches the decisions table (Director context) until a human accepts it.
    expect(k.decisions.list(project.id)).toEqual([]);
  });

  it("records an accepted decision only when a human accepts the ADR proposal (audit M3)", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const adr = updater.proposeEntries(deliveryId).find((p) => p.kind === "decision")!;
    const accepted = updater.accept(adr.id, "jacob");
    expect(accepted).toMatchObject({ status: "accepted", decidedBy: "jacob" });
    const decision = k.decisions.get(accepted.decisionId!)!;
    expect(decision).toMatchObject({
      status: "accepted",
      approver: "jacob",
      title: "Compare endpoint is read-only",
    });
    expect(decision.adrMarkdown).toContain("GET /compare never writes");
    expect(k.decisions.list(project.id)).toHaveLength(1);
    expect(k.knowledge.listValid(project.id)).toEqual([]);
    expect(() => updater.accept(adr.id, "jacob")).toThrow(/not proposed/);
  });

  it("is idempotent", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const first = updater.proposeEntries(deliveryId);
    const evidenceCount = k.evidence.list(project.id).length;
    expect(updater.proposeEntries(deliveryId)).toEqual(first);
    expect(k.evidence.list(project.id)).toHaveLength(evidenceCount);
    expect(k.decisions.list(project.id)).toEqual([]);
  });

  it("auto-accepts entries only when the project opts in", async () => {
    const { k, project, deliveryId, updater } = await delivered({ autoAcceptKnowledge: true });
    const proposals = updater.proposeEntries(deliveryId).filter((p) => p.kind === "entry");
    expect(proposals.every((p) => p.status === "accepted" && p.decidedBy === "auto")).toBe(true);
    expect(k.knowledge.listValid(project.id)).toHaveLength(proposals.length);
    // ADR drafts are never auto-accepted, and never written as decisions.
    expect(k.decisions.list(project.id)).toEqual([]);
  });

  it("treats a truthy but non-true setting as off", async () => {
    const { k, project, deliveryId, updater } = await delivered({ autoAcceptKnowledge: "yes" });
    updater.proposeEntries(deliveryId);
    expect(k.knowledge.listValid(project.id)).toEqual([]);
  });
});

describe("KnowledgeUpdater decisions on proposals", () => {
  it("accept turns a proposal into a valid knowledge entry sourced by task evidence", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const [p] = updater.proposeEntries(deliveryId).filter((x) => x.kind === "entry");
    const accepted = updater.accept(p!.id, "jacob");
    expect(accepted).toMatchObject({ status: "accepted", decidedBy: "jacob" });
    const entry = k.knowledge.get(accepted.entryId!)!;
    expect(entry).toMatchObject({ validity: "valid", claim: p!.claim, createdBy: "jacob" });
    expect(entry.sourceRefs).toEqual(p!.sourceRefs);
    expect(k.knowledge.listValid(project.id)).toHaveLength(1);
    expect(() => updater.accept(p!.id, "jacob")).toThrow(/not proposed/);
  });

  it("reject keeps it out of knowledge", async () => {
    const { k, project, deliveryId, updater } = await delivered();
    const [p] = updater.proposeEntries(deliveryId).filter((x) => x.kind === "entry");
    expect(updater.reject(p!.id, "jacob", "too specific")).toMatchObject({
      status: "rejected",
      reason: "too specific",
    });
    expect(k.knowledge.listValid(project.id)).toEqual([]);
  });
});

describe("KnowledgeUpdater.proposeEntry", () => {
  it("requires sources from the delivery's own evidence", async () => {
    const { deliveryId, updater, s } = await delivered();
    expect(() => updater.proposeEntry(deliveryId, { claim: "Uses Fastify", refs: [] })).toThrow(
      expect.objectContaining({ code: "source_required" }),
    );
    expect(() =>
      updater.proposeEntry(deliveryId, { claim: "Uses Fastify", refs: ["evt_made_up"] }),
    ).toThrow(expect.objectContaining({ code: "unknown_source" }));
    const run = s.reports.get(deliveryId)!.testResults[0]!.eventId;
    const p = updater.proposeEntry(deliveryId, { claim: "Tests run with pnpm", refs: [run] });
    expect(p).toMatchObject({ status: "proposed", kind: "entry" });
    expect(p.sourceRefs).toHaveLength(1);
  });

  it("is backed by a schema CHECK: no proposal row without sources", async () => {
    const { s, deliveryId } = await delivered();
    expect(() =>
      s.db
        .prepare(
          `INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, source_refs_json,
             confidence, status, created_at) VALUES ('kp', ?, 'p', 'entry', 'c', '[]', 0.5, 'proposed', 'now')`,
        )
        .run(deliveryId),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("KnowledgeUpdater fix round 1", () => {
  it("dedupes summary sentences that reduce to the same claim (M1)", async () => {
    const { deliveryId, updater } = await delivered(
      {},
      {
        responder: (req) => {
          const id = / id="([^"]+)"/.exec(req.messages[0]!.content)![1]!;
          return { text: `Brokkr passed [ref:${id}]. Brokkr passed [ref:${id}].` };
        },
      },
    );
    const claims = updater.proposeEntries(deliveryId).map((p) => p.claim);
    expect(claims.filter((c) => c === "Brokkr passed.")).toHaveLength(1);
  });

  it("stores project_id on its rows so a project purge can delete them", async () => {
    const { s, project, deliveryId, updater } = await delivered();
    updater.proposeEntries(deliveryId);
    for (const table of [
      "gate_evaluations",
      "reviews",
      "deliveries",
      "pr_requests",
      "delivery_evidence",
      "knowledge_proposals",
    ]) {
      const rows = s.db.prepare(`SELECT project_id FROM ${table}`).all() as {
        project_id: string | null;
      }[];
      expect(rows.length, table).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.project_id === project.id),
        table,
      ).toBe(true);
    }
  });
});
