import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openKnowledge, type Knowledge } from "./knowledge.js";

describe("knowledge store", () => {
  let k: Knowledge;
  let now = new Date("2026-01-01T00:00:00Z");
  let projectId: string;
  beforeEach(() => {
    now = new Date("2026-01-01T00:00:00Z");
    k = openKnowledge(":memory:", { now: () => now });
    projectId = k.projects.create({ name: "demo", repoPath: "/tmp/demo" }).id;
  });
  afterEach(() => k.close());

  describe("projects", () => {
    it("creates, gets and lists projects", () => {
      const p = k.projects.create({ name: "other", repoPath: "/r", settings: { a: 1 } });
      expect(k.projects.get(p.id)).toEqual(p);
      expect(p.settings).toEqual({ a: 1 });
      expect(k.projects.list().map((x) => x.name)).toEqual(["demo", "other"]);
      expect(k.projects.get("nope")).toBeUndefined();
    });

    it("replaces settings and stamps updatedAt; unknown projects are not_found", () => {
      k.projects.create({ name: "s", repoPath: "/s", settings: { a: 1, b: 2 } });
      const p = k.projects.list()[1]!;
      now = new Date("2026-02-01T00:00:00Z");
      const updated = k.projects.setSettings(p.id, { c: 3 });
      expect(updated).toMatchObject({ settings: { c: 3 }, updatedAt: "2026-02-01T00:00:00.000Z" });
      expect(k.projects.get(p.id)?.settings).toEqual({ c: 3 });
      expect(() => k.projects.setSettings("nope", {})).toThrow(/unknown project/);
    });
  });

  describe("knowledge entries", () => {
    it("requires at least one source ref", () => {
      expect(() =>
        k.knowledge.add({ projectId, claim: "x", sourceRefs: [], confidence: 0.5, createdBy: "u" }),
      ).toThrow(/source/i);
    });

    it("validates confidence range and referenced sources", () => {
      const base = { projectId, claim: "c", createdBy: "u" };
      expect(() =>
        k.knowledge.add({ ...base, sourceRefs: [{ url: "https://x.dev" }], confidence: 1.5 }),
      ).toThrow();
      expect(() =>
        k.knowledge.add({ ...base, sourceRefs: [{ taskEvidenceId: "missing" }], confidence: 0.5 }),
      ).toThrow(/evidence/i);
      expect(() =>
        k.knowledge.add({
          ...base,
          sourceRefs: [{ documentId: "missing", startLine: 1, endLine: 2 }],
          confidence: 0.5,
        }),
      ).toThrow(/document/i);
    });

    it("adds an entry backed by task evidence", () => {
      const ev = k.evidence.record({
        projectId,
        externalRef: "T-1",
        kind: "test-run",
        payload: { ok: true },
      });
      const e = k.knowledge.add({
        projectId,
        claim: "tests use vitest",
        sourceRefs: [{ taskEvidenceId: ev.id }],
        confidence: 0.9,
        createdBy: "director",
      });
      expect(e).toMatchObject({ validity: "valid", confidence: 0.9, supersedesId: null });
      expect(k.knowledge.listValid(projectId).map((x) => x.id)).toEqual([e.id]);
    });

    it("supports a supersession chain with full history", () => {
      const src = [{ url: "https://example.com/a" }];
      const a = k.knowledge.add({
        projectId,
        claim: "v1",
        sourceRefs: src,
        confidence: 0.5,
        createdBy: "u",
      });
      const b = k.knowledge.supersede(a.id, {
        claim: "v2",
        sourceRefs: src,
        confidence: 0.6,
        createdBy: "u",
      });
      const c = k.knowledge.supersede(b.id, {
        claim: "v3",
        sourceRefs: src,
        confidence: 0.7,
        createdBy: "u",
      });
      expect(c.supersedesId).toBe(b.id);
      expect(k.knowledge.get(a.id)?.validity).toBe("superseded");
      expect(k.knowledge.get(b.id)?.validity).toBe("superseded");
      expect(k.knowledge.listValid(projectId).map((x) => x.claim)).toEqual(["v3"]);
      for (const id of [a.id, b.id, c.id]) {
        expect(k.knowledge.history(id).map((x) => x.claim)).toEqual(["v1", "v2", "v3"]);
      }
      expect(() =>
        k.knowledge.supersede(a.id, {
          claim: "fork",
          sourceRefs: src,
          confidence: 1,
          createdBy: "u",
        }),
      ).toThrow(/valid/i);
    });

    it("history is empty for an unknown id and stops at a missing or cyclic predecessor", () => {
      expect(k.knowledge.history("nope")).toEqual([]);
      const src = [{ url: "https://example.com/a" }];
      const a = k.knowledge.add({
        projectId,
        claim: "a",
        sourceRefs: src,
        confidence: 1,
        createdBy: "u",
      });
      const b = k.knowledge.supersede(a.id, {
        claim: "b",
        sourceRefs: src,
        confidence: 1,
        createdBy: "u",
      });
      // A predecessor purged by retention leaves a dangling supersedes_id.
      k.db.pragma("foreign_keys = OFF");
      k.db.prepare("UPDATE knowledge_entries SET supersedes_id = 'gone' WHERE id = ?").run(a.id);
      expect(k.knowledge.history(b.id).map((e) => e.claim)).toEqual(["a", "b"]);
      // A corrupted cycle a -> b -> a must terminate.
      k.db.prepare("UPDATE knowledge_entries SET supersedes_id = ? WHERE id = ?").run(b.id, a.id);
      expect(k.knowledge.history(b.id).map((e) => e.claim)).toEqual(["a", "b"]);
    });

    it("retracts entries and purges old retracted ones", () => {
      const src = [{ url: "https://example.com/a" }];
      const a = k.knowledge.add({
        projectId,
        claim: "wrong",
        sourceRefs: src,
        confidence: 0.2,
        createdBy: "u",
      });
      const keep = k.knowledge.add({
        projectId,
        claim: "right",
        sourceRefs: src,
        confidence: 0.9,
        createdBy: "u",
      });
      const r = k.knowledge.retract(a.id, "user correction");
      expect(r).toMatchObject({ validity: "retracted", retractedReason: "user correction" });
      expect(k.knowledge.listValid(projectId).map((x) => x.id)).toEqual([keep.id]);
      expect(k.knowledge.purgeRetracted({ olderThanDays: 30 })).toBe(0);
      now = new Date("2026-03-01T00:00:00Z");
      expect(k.knowledge.purgeRetracted({ olderThanDays: 30 })).toBe(1);
      expect(k.knowledge.get(a.id)).toBeUndefined();
      expect(k.knowledge.get(keep.id)).toBeDefined();
    });
  });

  describe("task evidence", () => {
    it("is immutable: no update API and raw updates/deletes throw", () => {
      const ev = k.evidence.record({
        projectId,
        externalRef: "PR-9",
        kind: "review",
        payload: { lgtm: 1 },
      });
      expect(k.evidence.get(ev.id)).toEqual(ev);
      expect(k.evidence.list(projectId)).toEqual([ev]);
      // Read-only lookups plus append; erasure happens only through projects.purge.
      expect(Object.keys(k.evidence).sort()).toEqual(["erased", "get", "list", "record"]);
      expect(() =>
        k.db.prepare("UPDATE task_evidence SET kind = 'tampered' WHERE id = ?").run(ev.id),
      ).toThrow(/immutable/);
      expect(() => k.db.prepare("DELETE FROM task_evidence WHERE id = ?").run(ev.id)).toThrow(
        /immutable/,
      );
    });
  });

  it("stores an undefined evidence payload as null", () => {
    const ev = k.evidence.record({
      projectId,
      externalRef: "T-2",
      kind: "note",
      payload: undefined,
    });
    expect(ev.payload).toBeNull();
    expect(k.evidence.get(ev.id)?.payload).toBeNull();
  });

  describe("decisions", () => {
    it("defaults to proposed with no approver", () => {
      const d = k.decisions.record({ projectId, title: "Maybe", adrMarkdown: "# ADR" });
      expect(d).toMatchObject({ status: "proposed", approver: null });
      expect(k.decisions.get(d.id)).toEqual(d);
      expect(k.decisions.get("nope")).toBeUndefined();
    });

    it("records ADR decisions with approver", () => {
      const d = k.decisions.record({
        projectId,
        title: "Use SQLite",
        adrMarkdown: "# ADR 1\nUse SQLite.",
        status: "accepted",
        approver: "jacob",
      });
      expect(k.decisions.list(projectId)).toEqual([d]);
      expect(k.decisions.get(d.id)?.approver).toBe("jacob");
    });
  });

  it("can share an existing database handle", async () => {
    const { openDatabase } = await import("./db.js");
    const db = openDatabase(":memory:");
    const k2 = openKnowledge(db);
    expect(k2.db).toBe(db);
    expect(k2.projects.list()).toEqual([]);
    db.close();
  });
});
