import { describe, expect, it } from "vitest";
import { OTHER, PROJECT, testDb } from "./fakes.js";
import { StewardStore, type NewDecision } from "./store.js";
import { isDecisionType } from "./types.js";

const decision = (over: Partial<NewDecision> = {}): NewDecision => ({
  projectId: PROJECT,
  type: "escalation.resolve",
  dedupeKey: "exe-1:T1:1",
  subject: { kind: "task", id: "exe-1:T1", label: "T1: tests failed" },
  context: { executionId: "exe-1" },
  mode: "recommend",
  ...over,
});

describe("StewardStore", () => {
  it("defaults to the wall clock and exposes its database", () => {
    const db = testDb();
    const store = new StewardStore(db);
    expect(store.db).toBe(db);
    const d = store.create(decision())!;
    expect(Math.abs(Date.parse(d.createdAt) - Date.now())).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("finds a decision by type and dedupe key; a missing context is stored as null", () => {
    const store = new StewardStore(testDb());
    const d = store.create(decision({ context: undefined }))!;
    expect(store.byKey("escalation.resolve", "exe-1:T1:1")).toMatchObject({
      id: d.id,
      context: null,
    });
    expect(store.byKey("escalation.resolve", "nope")).toBeUndefined();
    expect(store.byKey("spec.answer", "exe-1:T1:1")).toBeUndefined();
  });

  it("refuses a second decision for a dedupe key, and a second pending one for a subject", () => {
    const store = new StewardStore(testDb());
    expect(store.create(decision())).toBeDefined();
    expect(store.create(decision())).toBeUndefined();
    expect(store.create(decision({ dedupeKey: "exe-1:T1:2" }))).toBeUndefined();
    expect(store.pending()).toHaveLength(1);
  });

  it("lists before a timestamp when the cursor is not a decision id", () => {
    let t = Date.parse("2026-03-01T00:00:00Z");
    const store = new StewardStore(testDb(), () => new Date((t += 60_000)));
    store.create(decision());
    const second = store.create(
      decision({ dedupeKey: "k2", subject: { kind: "task", id: "s2", label: "two" } }),
    )!;
    expect(store.list({ before: second.createdAt }).map((d) => d.dedupeKey)).toEqual([
      "exe-1:T1:1",
    ]);
    expect(store.list({ before: "2000-01-01T00:00:00Z" })).toEqual([]);
    expect(store.list({ limit: 0 })).toHaveLength(1);
    expect(store.list({ limit: 10_000 })).toHaveLength(2);
  });

  it("filters pending decisions by type", () => {
    const store = new StewardStore(testDb());
    store.create(decision());
    store.create(
      decision({
        type: "spec.answer",
        dedupeKey: "lin:Q1",
        subject: { kind: "question", id: "lin:Q1", label: "Q" },
      }),
    );
    expect(store.pending("spec.answer").map((d) => d.type)).toEqual(["spec.answer"]);
    expect(store.pending()).toHaveLength(2);
  });

  it("updates nothing for an unknown id or an unexpected status, and clears nullable fields", () => {
    const store = new StewardStore(testDb());
    const d = store.create(decision())!;
    expect(store.update("sd_missing", { error: "x" }, { action: "a", actor: "t" })).toBeUndefined();
    expect(
      store.update(d.id, { error: "x" }, { action: "a", actor: "t" }, { status: "accepted" }),
    ).toBeUndefined();
    const applied = store.update(
      d.id,
      { status: "accepted", applied: { a: 1 }, outcome: { result: "passed" }, finalValue: "retry" },
      { action: "accepted", actor: "op" },
    )!;
    expect(applied).toMatchObject({ applied: { a: 1 }, outcome: { result: "passed" } });
    const cleared = store.update(
      d.id,
      { applied: null, outcome: null, confidence: 7 },
      { action: "edit", actor: "op" },
      { status: ["accepted", "changed"] },
    )!;
    expect(cleared).toMatchObject({ applied: null, outcome: null, confidence: 1 });
    expect(store.history(d.id).at(-1)).toMatchObject({ action: "edit" });
    expect(store.history(d.id).at(-1)!.detail).not.toHaveProperty("detail");
  });

  it("records events on existing decisions only", () => {
    const store = new StewardStore(testDb());
    const d = store.create(decision())!;
    store.record(d.id, "apply_failed", "op", undefined);
    store.record("sd_missing", "apply_failed", "op", { x: 1 });
    expect(store.history(d.id).at(-1)).toMatchObject({ action: "apply_failed", detail: null });
    expect(store.history("sd_missing")).toEqual([]);
  });

  it("lists every note without a project argument; project notes include global ones", () => {
    const store = new StewardStore(testDb());
    store.addNote({ projectId: null, author: "op", text: "global" });
    store.addNote({ projectId: PROJECT, author: "op", text: "mine" });
    store.addNote({ projectId: OTHER, author: "op", text: "other" });
    expect(
      store
        .notes()
        .map((n) => n.text)
        .sort(),
    ).toEqual(["global", "mine", "other"]);
    expect(
      store
        .notes(PROJECT)
        .map((n) => n.text)
        .sort(),
    ).toEqual(["global", "mine"]);
    expect(store.notes(null).map((n) => n.text)).toEqual(["global"]);
  });

  it("proposes a guidance rule once and decides it once", () => {
    const store = new StewardStore(testDb());
    const input = {
      projectId: PROJECT,
      type: "escalation.resolve" as const,
      signature: "rejected:abort",
      rule: "Do not abort.",
      decisionIds: ["sd_1"],
    };
    const g = store.proposeGuidance(input)!;
    expect(store.proposeGuidance(input)).toBeUndefined();
    store.proposeGuidance({ ...input, projectId: OTHER });
    expect(
      store
        .listGuidance()
        .map((x) => x.projectId)
        .sort(),
    ).toEqual([PROJECT, OTHER].sort());
    expect(store.hasGuidance(PROJECT, "escalation.resolve", "rejected:abort")).toBe(true);
    expect(store.decideGuidance(g.id, { status: "rejected", by: "op" })).toMatchObject({
      status: "rejected",
      reason: null,
      entryId: null,
    });
    expect(store.decideGuidance(g.id, { status: "accepted", by: "op" })).toBeUndefined();
    expect(store.guidanceEntryIds(PROJECT)).toEqual(new Set());
  });

  it("stats: accuracy counts auto-applied decisions whose outcome failed against it", () => {
    const store = new StewardStore(testDb());
    expect(store.stats("escalation.resolve").accuracy).toBeNull();
    const a = store.create(decision())!;
    store.update(
      a.id,
      { status: "applied", outcome: { result: "failed" } },
      { action: "applied", actor: "steward" },
    );
    const b = store.create(
      decision({ dedupeKey: "k2", subject: { kind: "task", id: "s2", label: "b" } }),
    )!;
    store.update(b.id, { status: "applied" }, { action: "applied", actor: "steward" });
    expect(store.stats("escalation.resolve")).toMatchObject({
      decided: 2,
      autoApplied: 2,
      accuracy: 0.5,
    });
  });
});

describe("isDecisionType", () => {
  it("accepts the five decision types only", () => {
    expect(isDecisionType("spec.answer")).toBe(true);
    expect(isDecisionType("plan.approve")).toBe(true);
    expect(isDecisionType("spec.reject")).toBe(false);
  });
});
