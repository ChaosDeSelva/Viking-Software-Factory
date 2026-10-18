import { openIntake } from "@sindri/intake";
import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSpecs, type Specs } from "./specs.js";
import type { Provenance, SpecBody } from "./body.js";

describe("specifications", () => {
  let db: SqliteDatabase;
  let specs: Specs;
  let projectId: string;
  let intakeId: string;
  let entryId: string;
  let now: Date;

  const body = (over: Partial<SpecBody> = {}): SpecBody => ({
    problem: "Reports cannot be exported.",
    goals: ["CSV export"],
    nonGoals: ["PDF export"],
    constraints: ["Max 50k rows"],
    assumptions: [{ text: "Filters apply to export", risk: "low" }],
    acceptanceCriteria: [
      { id: "AC-1", text: "Download CSV of current view", verification: "test" },
    ],
    risks: ["Large exports time out"],
    openQuestions: [{ id: "Q1", text: "Date format?", blocking: false }],
    ...over,
  });
  const prov = (over: Partial<Provenance> = {}): Provenance => ({
    problem: [{ intakeId }],
    goals: [{ intakeId }],
    nonGoals: [],
    constraints: [{ knowledgeEntryId: entryId }],
    assumptions: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria: { "AC-1": [{ intakeId }] },
    ...over,
  });

  beforeEach(() => {
    db = openDatabase(":memory:");
    now = new Date("2026-10-01T00:00:00Z");
    const k = openKnowledge(db);
    projectId = k.projects.create({ name: "demo", repoPath: "/tmp/demo" }).id;
    entryId = k.knowledge.add({
      projectId,
      claim: "Exports are capped at 50k rows",
      sourceRefs: [{ url: "https://example.com/limits" }],
      confidence: 0.8,
      createdBy: "u",
    }).id;
    intakeId = openIntake(db).createManual({ projectId, title: "CSV export", body: "pls" }).id;
    specs = openSpecs(db, { now: () => now });
  });
  afterEach(() => db.close());

  const draft = (b = body(), p = prov()) =>
    specs.createDraft({ projectId, intakeId, title: "CSV export", body: b, provenance: p });

  describe("createDraft", () => {
    it("creates version 1 of a new lineage in draft", () => {
      const s = draft();
      expect(s).toMatchObject({ version: 1, status: "draft", intakeId, title: "CSV export" });
      expect(s.lineageId).toBeTruthy();
      expect(specs.get(s.id)).toEqual(s);
    });

    it("validates the body with Zod", () => {
      expect(() =>
        draft(
          body({
            acceptanceCriteria: [{ id: "AC-1", text: "x", verification: "vibes" as "test" }],
          }),
        ),
      ).toThrow(/verification/);
      expect(() =>
        draft(body({ assumptions: [{ text: "a", risk: "extreme" as "low" }] })),
      ).toThrow();
      expect(() =>
        draft(
          body({
            acceptanceCriteria: [
              { id: "AC-1", text: "a", verification: "test" },
              { id: "AC-1", text: "b", verification: "manual" },
            ],
          }),
        ),
      ).toThrow(/duplicate/i);
    });

    it("requires non-empty provenance for problem and every acceptance criterion", () => {
      expect(() => draft(body(), prov({ problem: [] }))).toThrow(/problem/);
      expect(() => draft(body(), prov({ acceptanceCriteria: {} }))).toThrow(/AC-1/);
      expect(() => draft(body(), prov({ acceptanceCriteria: { "AC-1": [] } }))).toThrow(/AC-1/);
    });

    it("rejects provenance refs that do not exist", () => {
      expect(() => draft(body(), prov({ problem: [{ knowledgeEntryId: "nope" }] }))).toThrow(
        /knowledge entry/,
      );
      expect(() => draft(body(), prov({ problem: [{ intakeId: "nope" }] }))).toThrow(/intake/);
      expect(() => draft(body(), prov({ problem: [{ taskEvidenceId: "nope" }] }))).toThrow(
        /evidence/,
      );
    });
  });

  describe("lifecycle", () => {
    it("revise creates a new version; the old one is superseded only when the new one is approved", () => {
      const v1 = draft();
      specs.submitForReview(v1.id);
      const a1 = specs.approve(v1.id, { approver: "jacob" });
      expect(a1).toMatchObject({
        status: "approved",
        approvedBy: "jacob",
        approvedAt: now.toISOString(),
      });

      const v2 = specs.revise(v1.id, { body: { goals: ["CSV export", "XLSX export"] } });
      expect(v2).toMatchObject({ version: 2, status: "draft", lineageId: v1.lineageId, intakeId });
      expect(v2.body.goals).toEqual(["CSV export", "XLSX export"]);
      expect(v2.body.problem).toBe(v1.body.problem);
      expect(specs.get(v1.id)?.status).toBe("approved");

      specs.submitForReview(v2.id);
      specs.approve(v2.id, { approver: "jacob" });
      expect(specs.get(v1.id)?.status).toBe("superseded");
      expect(specs.listLineage(v1.lineageId).map((s) => [s.version, s.status])).toEqual([
        [1, "superseded"],
        [2, "approved"],
      ]);
    });

    it("only the latest version can be revised or approved", () => {
      const v1 = draft();
      specs.revise(v1.id, { title: "v2" });
      expect(() => specs.revise(v1.id, { title: "fork" })).toThrow(/latest/);
      expect(() => specs.submitForReview(v1.id)).toThrow(/latest/);
    });

    it("approval requires review status and rejects blocking open questions", () => {
      const v1 = draft(
        body({ openQuestions: [{ id: "Q1", text: "Which formats?", blocking: true }] }),
      );
      expect(() => specs.approve(v1.id, { approver: "j" })).toThrow(/review/);
      specs.submitForReview(v1.id);
      expect(() => specs.approve(v1.id, { approver: "j" })).toThrow(/blocking.*Q1/);
      const v2 = specs.revise(v1.id, {
        body: { openQuestions: [{ id: "Q1", text: "Which formats?", blocking: false }] },
      });
      specs.submitForReview(v2.id);
      expect(specs.approve(v2.id, { approver: "j" }).status).toBe("approved");
      expect(specs.get(v1.id)?.status).toBe("superseded");
    });

    it("revise re-validates provenance for new acceptance criteria", () => {
      const v1 = draft();
      expect(() =>
        specs.revise(v1.id, {
          body: {
            acceptanceCriteria: [
              { id: "AC-1", text: "Download CSV", verification: "test" },
              { id: "AC-2", text: "Shows progress", verification: "screenshot" },
            ],
          },
        }),
      ).toThrow(/AC-2/);
    });

    it("enforces UNIQUE(project_id, lineage_id, version)", () => {
      const v1 = draft();
      expect(() =>
        db
          .prepare(
            `INSERT INTO specifications (id, project_id, lineage_id, version, status, title, body_json,
               provenance_json, created_at) SELECT 'dup', project_id, lineage_id, version, status, title,
               body_json, provenance_json, created_at FROM specifications WHERE id = ?`,
          )
          .run(v1.id),
      ).toThrow(/UNIQUE/);
    });
  });

  describe("fix round 1", () => {
    it("M10: approved and superseded specs are immutable in the database", () => {
      const v1 = draft();
      specs.submitForReview(v1.id);
      specs.approve(v1.id, { approver: "jacob" });
      const tamper = (sql: string) => () => db.prepare(sql).run(v1.id);
      expect(tamper("UPDATE specifications SET title = 'hacked' WHERE id = ?")).toThrow(
        /immutable/,
      );
      expect(tamper("UPDATE specifications SET body_json = '{}' WHERE id = ?")).toThrow(
        /immutable/,
      );
      expect(tamper("UPDATE specifications SET provenance_json = '{}' WHERE id = ?")).toThrow(
        /immutable/,
      );
      expect(tamper("UPDATE specifications SET status = 'draft' WHERE id = ?")).toThrow(
        /immutable/,
      );
      // the lifecycle transition approved -> superseded is still allowed
      const v2 = specs.revise(v1.id, { title: "v2" });
      specs.submitForReview(v2.id);
      specs.approve(v2.id, { approver: "jacob" });
      expect(specs.get(v1.id)?.status).toBe("superseded");
      expect(tamper("UPDATE specifications SET status = 'approved' WHERE id = ?")).toThrow(
        /immutable/,
      );
    });

    it("M16: document provenance refs require endLine >= startLine", () => {
      const docId = (
        db
          .prepare(
            "INSERT INTO documents (id, project_id, path, kind, sha256, bytes, indexed_at) VALUES ('d1', ?, 'README.md', 'readme', 'x', 1, 'now') RETURNING id",
          )
          .get(projectId) as { id: string }
      ).id;
      expect(() =>
        draft(body(), prov({ goals: [{ documentId: docId, startLine: 5, endLine: 2 }] })),
      ).toThrow(/endLine/);
      expect(() =>
        draft(body(), prov({ goals: [{ documentId: docId, startLine: 2, endLine: 5 }] })),
      ).not.toThrow();
    });
  });

  describe("diff", () => {
    it("returns a structured diff between two versions", () => {
      const v1 = draft();
      const v2 = specs.revise(v1.id, {
        title: "CSV + XLSX export",
        body: {
          goals: ["CSV export", "XLSX export"],
          nonGoals: [],
          assumptions: [{ text: "Filters apply to export", risk: "medium" }],
          acceptanceCriteria: [
            { id: "AC-1", text: "Download CSV of current view", verification: "screenshot" },
            { id: "AC-2", text: "Download XLSX", verification: "test" },
          ],
          openQuestions: [],
        },
        provenance: { acceptanceCriteria: { "AC-1": [{ intakeId }], "AC-2": [{ intakeId }] } },
      });
      const d = specs.diff(v1.id, v2.id);
      expect(d.from).toEqual({ id: v1.id, version: 1 });
      expect(d.to).toEqual({ id: v2.id, version: 2 });
      expect(d.title).toEqual({ from: "CSV export", to: "CSV + XLSX export" });
      expect(d.problem).toBeUndefined();
      expect(d.goals).toEqual({ added: ["XLSX export"], removed: [] });
      expect(d.nonGoals).toEqual({ added: [], removed: ["PDF export"] });
      expect(d.constraints).toEqual({ added: [], removed: [] });
      expect(d.assumptions.changed).toEqual([
        {
          key: "Filters apply to export",
          from: { text: "Filters apply to export", risk: "low" },
          to: { text: "Filters apply to export", risk: "medium" },
        },
      ]);
      expect(d.acceptanceCriteria.added.map((a) => a.id)).toEqual(["AC-2"]);
      expect(
        d.acceptanceCriteria.changed.map((c) => [c.key, c.from.verification, c.to.verification]),
      ).toEqual([["AC-1", "test", "screenshot"]]);
      expect(d.openQuestions.removed.map((q) => q.id)).toEqual(["Q1"]);
      expect(d.changed).toBe(true);
      expect(specs.diff(v1.id, v1.id).changed).toBe(false);
    });

    it("refuses to diff across lineages", () => {
      const a = draft();
      const b = draft();
      expect(() => specs.diff(a.id, b.id)).toThrow(/lineage/);
    });
  });

  describe("render", () => {
    it("renders markdown with every section and its provenance", () => {
      const v1 = draft(
        body({
          problem: "Reports cannot be exported.<script>alert(1)</script>",
          openQuestions: [{ id: "Q1", text: "Date format?", blocking: true }],
        }),
      );
      const md = specs.render(v1.id);
      expect(md).toContain("# CSV export");
      expect(md).toContain("Version 1 · draft");
      for (const h of [
        "## Problem",
        "## Goals",
        "## Non-goals",
        "## Constraints",
        "## Assumptions",
        "## Acceptance criteria",
        "## Risks",
        "## Open questions",
      ]) {
        expect(md).toContain(h);
      }
      expect(md).toContain("- **AC-1** (test): Download CSV of current view");
      expect(md).toContain("- [low risk] Filters apply to export");
      expect(md).toContain("- **Q1** (blocking): Date format?");
      expect(md).toContain(`intake:${intakeId}`);
      expect(md).toContain(`knowledge:${entryId}`);
      expect(md).not.toContain("<script>");
    });
  });
});
