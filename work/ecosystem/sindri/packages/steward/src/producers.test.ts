import { describe, expect, it } from "vitest";
import {
  delivery,
  escalation,
  FakeWorld,
  planProposed,
  PROJECT,
  question,
  specReview,
  testDb,
} from "./fakes.js";
import * as api from "./index.js";
import { gatherLearning, learningInputs, pastSummary } from "./learning.js";
import { discover, heuristic, subjectInputs } from "./producers.js";
import { recommendationRequest } from "./prompt.js";
import { StewardStore, type StoredDecision } from "./store.js";

const only = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

describe("@sindri/steward", () => {
  it("exports its package name and public API", () => {
    expect(api.PACKAGE_NAME).toBe("@sindri/steward");
    for (const name of [
      "Steward",
      "StewardStore",
      "discover",
      "gatherLearning",
      "isDecisionType",
    ] as const)
      expect(typeof api[name]).toBe("function");
    expect(api.DECISION_TYPES).toHaveLength(5);
  });
});

describe("discover", () => {
  it("skips a failing reader without an error callback", () => {
    const world = new FakeWorld();
    world.e = [escalation()];
    world.questions = () => {
      throw new Error("down");
    };
    const { candidates, scanned } = discover(world, () => true);
    expect(candidates.map((c) => c.type)).toEqual(["escalation.resolve"]);
    expect(scanned.has("spec.answer")).toBe(false);
  });

  it("labels subjects without optional fields and clips long ones", () => {
    const world = new FakeWorld();
    world.e = [escalation({ objective: null, reason: null, escalation: "ask" })];
    world.d = [delivery({ specTitle: null })];
    world.p = [planProposed({ specTitle: null })];
    world.q = [question({}, { text: "q".repeat(400) })];
    const { candidates } = discover(world, () => true);
    const label = (t: string) => candidates.find((c) => c.type === t)!.subject.label;
    expect(label("escalation.resolve")).toBe("T1: ask");
    expect(label("rework.suggest")).toBe("Delivery of exe-9");
    expect(label("plan.approve")).toBe("Plan v1 for spec-3");
    expect(label("spec.answer")).toHaveLength(300);
    expect(label("spec.answer").endsWith("…")).toBe(true);
  });
});

describe("subject inputs and heuristics", () => {
  const candidate = (type: string, world: FakeWorld) =>
    discover(world, (t) => t === type).candidates[0]!;

  it("an escalation without a reason says so", () => {
    const w = new FakeWorld();
    w.e = [escalation({ reason: null })];
    expect(only(subjectInputs(candidate("escalation.resolve", w))).summary).toMatch(
      /no reason recorded/,
    );
  });

  it("a delivery with a failed gate lists its failures and goes to the provider", () => {
    const w = new FakeWorld();
    w.d = [
      delivery({ gates: [{ planTaskId: "T1", passed: false, failures: ["lint: 3 errors"] }] }),
    ];
    const c = candidate("rework.suggest", w);
    expect(only(subjectInputs(c)).summary).toBe("T1: failed (lint: 3 errors)");
    expect(heuristic(c)).toBeNull();
  });

  it("a delivery whose passing gate has advisories goes to the provider", () => {
    const w = new FakeWorld();
    w.d = [
      delivery({ gates: [{ planTaskId: "T1", passed: true, failures: ["style: long line"] }] }),
    ];
    expect(heuristic(candidate("rework.suggest", w))).toBeNull();
  });

  it("a spec whose sources had flagged instructions is held for a person", () => {
    const w = new FakeWorld();
    w.s = [specReview({ untrustedFlagged: true })];
    const c = candidate("spec.approve", w);
    expect(only(subjectInputs(c)).summary).toMatch(/flagged instructions in its sources/);
    expect(heuristic(c)).toMatchObject({
      value: "hold",
      detail: "its sources contained flagged instructions a person must review",
    });
  });

  it("a plan without tasks or with dry-run problems is held", () => {
    const w = new FakeWorld();
    w.p = [planProposed({ tasks: [], problems: ["cycle T1 -> T2"] })];
    const c = candidate("plan.approve", w);
    expect(only(subjectInputs(c)).summary).toMatch(
      /0 task\(s\) for an approved spec; dry run: cycle/,
    );
    expect(heuristic(c)).toMatchObject({
      value: "hold",
      detail: "it has no tasks; dry run: cycle T1 -> T2",
    });
  });

  it("a drafter suggestion without a rationale says only that", () => {
    const w = new FakeWorld();
    w.q = [question({}, { recommendation: "Comma" })];
    expect(heuristic(candidate("spec.answer", w))).toMatchObject({
      value: "Comma",
      reasoning: "The drafter suggested this answer.",
    });
  });
});

describe("learning inputs", () => {
  const stored = (over: Partial<StoredDecision>): StoredDecision =>
    ({
      id: "sd_1",
      subject: { kind: "task", id: "s", label: "T1: flaky" },
      recommendation: { value: "retry" },
      appliedValue: null,
      outcome: null,
      status: "accepted",
      ...over,
    }) as StoredDecision;

  it("summarises what became of a past decision", () => {
    expect(pastSummary(stored({ status: "rejected" }))).toBe(
      'T1: flaky: recommended "retry", operator rejected it',
    );
    expect(pastSummary(stored({ status: "rolled_back" }))).toMatch(/applied, then rolled back$/);
    expect(pastSummary(stored({ status: "applied", outcome: { result: "failed" } }))).toBe(
      'T1: flaky: recommended "retry", applied; outcome failed',
    );
    expect(pastSummary(stored({ status: "changed" }))).toMatch(/changed it to ""$/);
  });

  it("a world that cannot list knowledge yields none; global notes and untitled lessons are labelled", async () => {
    const db = testDb();
    const store = new StewardStore(db);
    store.addNote({ projectId: null, author: "op", text: "Prefer small diffs" });
    const world = new FakeWorld();
    world.knowledge = () => {
      throw new Error("knowledge locked");
    };
    const lessons = {
      lessonsFor: () =>
        Promise.resolve([
          {
            id: "L1",
            title: "",
            rule: "Run the linter",
            appliesWhen: "editing TS",
            paths: ["src/"],
            status: "approved",
          },
        ]),
    };
    const l = await gatherLearning({
      store,
      world,
      lessons,
      projectId: PROJECT,
      type: "spec.answer",
      query: "x",
    });
    expect(l.knowledge).toEqual([]);
    const inputs = learningInputs(l);
    expect(inputs.map((i) => i.summary)).toEqual([
      "global note by op: Prefer small diffs",
      "Run the linter",
    ]);
    const w = new FakeWorld();
    w.q = [question()];
    const c = discover(w, () => true).candidates[0]!;
    const content = String(recommendationRequest(c, l, null).messages[0]!.content);
    expect(content).toMatch(/scope="global"/);
    expect(content).toMatch(/Applies when: editing TS/);
    expect(content).toMatch(/Paths: src\//);
  });

  it("limits lessons to the configured number even if the source returns more", async () => {
    const store = new StewardStore(testDb());
    const lesson = (id: string) => ({
      id,
      title: id,
      rule: "r",
      appliesWhen: null,
      paths: [],
      status: "approved",
    });
    const l = await gatherLearning({
      store,
      world: new FakeWorld(),
      lessons: { lessonsFor: () => Promise.resolve([lesson("a"), lesson("b"), lesson("c")]) },
      projectId: PROJECT,
      type: "spec.answer",
      query: "x",
      limits: { lessons: 2 },
    });
    expect(l.lessons.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
