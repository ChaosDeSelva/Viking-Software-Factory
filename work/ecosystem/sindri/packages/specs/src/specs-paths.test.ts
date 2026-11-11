import { openIntake } from "@sindri/intake";
import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Provenance, SpecBody } from "./body.js";
import { renderSpec, type RenderInput } from "./render.js";
import { openSpecs, SpecStateError, SpecValidationError, type Specs } from "./specs.js";

describe("specification paths", () => {
  let db: SqliteDatabase;
  let specs: Specs;
  let projectId: string;
  let intakeId: string;
  let evidenceId: string;

  const body = (over: Partial<SpecBody> = {}): SpecBody => ({
    problem: "Reports cannot be exported.",
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    acceptanceCriteria: [{ id: "AC-1", text: "Download CSV", verification: "test" }],
    risks: [],
    openQuestions: [],
    ...over,
  });
  const prov = (over: Partial<Provenance> = {}): Provenance => ({
    problem: [{ intakeId }],
    goals: [],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria: { "AC-1": [{ intakeId }] },
    ...over,
  });
  const draft = (b = body(), p = prov()) =>
    specs.createDraft({ projectId, intakeId, title: "CSV export", body: b, provenance: p });

  beforeEach(() => {
    db = openDatabase(":memory:");
    const k = openKnowledge(db);
    projectId = k.projects.create({ name: "demo", repoPath: "/tmp/demo" }).id;
    evidenceId = k.evidence.record({
      projectId,
      externalRef: "T-1",
      kind: "test-run",
      payload: null,
    }).id;
    intakeId = openIntake(db).createManual({ projectId, title: "CSV export", body: "pls" }).id;
    specs = openSpecs(db);
  });
  afterEach(() => db.close());

  describe("provenance references", () => {
    it("accepts task evidence of the project and rejects unknown evidence", () => {
      expect(
        draft(body(), prov({ risks: [{ taskEvidenceId: evidenceId }] })).provenance.risks,
      ).toEqual([{ taskEvidenceId: evidenceId }]);
      expect(() => draft(body(), prov({ risks: [{ taskEvidenceId: "nope" }] }))).toThrow(
        new SpecValidationError("provenance.risks: task evidence nope not found"),
      );
    });

    it("rejects a document that does not exist", () => {
      expect(() => draft(body(), prov({ goals: [{ documentId: "nope" }] }))).toThrow(
        "provenance.goals: document nope not found",
      );
    });

    it("rejects provenance for a criterion the body does not have", () => {
      expect(() =>
        draft(
          body(),
          prov({ acceptanceCriteria: { "AC-1": [{ intakeId }], "AC-9": [{ intakeId }] } }),
        ),
      ).toThrow("provenance references unknown acceptance criterion AC-9");
    });

    it("names the root when the whole body is not an object", () => {
      expect(() => draft(null as unknown as SpecBody)).toThrow(/invalid spec body: \(root\): /);
    });
  });

  describe("lifecycle", () => {
    it("refuses a blank approver before touching the spec", () => {
      const s = draft();
      specs.submitForReview(s.id);
      expect(() => specs.approve(s.id, { approver: " " })).toThrow(
        new SpecValidationError("approver is required"),
      );
      expect(specs.get(s.id)?.status).toBe("review");
    });

    it("cannot revise a superseded version that is still the newest", () => {
      const s = draft();
      // Only reachable by a status change outside the API (e.g. an older database).
      db.prepare("UPDATE specifications SET status = 'superseded' WHERE id = ?").run(s.id);
      expect(() => specs.revise(s.id, { title: "x" })).toThrow(
        new SpecStateError("cannot revise a superseded spec"),
      );
    });

    it("reports a problem change in the diff", () => {
      const v1 = draft();
      const v2 = specs.revise(v1.id, { body: { problem: "Exports are too slow." } });
      expect(specs.diff(v1.id, v2.id)).toMatchObject({
        problem: { from: "Reports cannot be exported.", to: "Exports are too slow." },
        changed: true,
      });
      expect(specs.diff(v1.id, v1.id).changed).toBe(false);
    });

    it("opens and closes its own database from a path", () => {
      const own = openSpecs(":memory:");
      expect(own.listByProject("p")).toEqual([]);
      own.close();
      expect(() => own.get("x")).toThrow();
    });
  });
});

describe("renderSpec", () => {
  const base = (over: Partial<RenderInput> = {}): RenderInput => ({
    title: "T",
    version: 2,
    status: "approved",
    approvedBy: null,
    approvedAt: null,
    body: {
      problem: "P",
      goals: [],
      nonGoals: [],
      constraints: [],
      assumptions: [],
      acceptanceCriteria: [],
      risks: [],
      openQuestions: [],
    },
    provenance: {
      problem: [],
      goals: [],
      nonGoals: [],
      constraints: [],
      assumptions: [],
      risks: [],
      openQuestions: [],
      acceptanceCriteria: {},
    },
    ...over,
  });

  it("labels every kind of source, with or without a line range", () => {
    const out = renderSpec(
      base({
        provenance: {
          ...base().provenance,
          problem: [
            { taskEvidenceId: "e1" },
            { documentId: "d1" },
            { documentId: "d2", startLine: 3 },
            { documentId: "d3", startLine: 3, endLine: 9 },
          ],
        },
      }),
    );
    expect(out).toContain("_Sources: evidence:e1, document:d1, document:d2#L3, document:d3#L3-L9_");
  });

  it("shows an approver without a date and a spec without criteria", () => {
    const out = renderSpec(base({ approvedBy: "jacob <b>x</b>" }));
    expect(out).toContain("_Version 2 · approved · approved by jacob x at ?_");
    expect(out).toContain("## Acceptance criteria\n\n_None._\n");
  });

  it("renders open questions with and without a recommendation and rationale", () => {
    const out = renderSpec(
      base({
        body: {
          ...base().body,
          openQuestions: [
            { id: "Q1", text: "Format?", blocking: true, recommendation: "ISO", rationale: "std" },
            { id: "Q2", text: "Limit?", blocking: false },
          ],
        },
      }),
    );
    expect(out).toContain(
      "- **Q1** (blocking): Format?\n  - Recommended answer: ISO\n  - Why: std\n- **Q2** (non-blocking): Limit?\n",
    );
  });
});
