import { FakeProvider, ProviderError, type FakeResponder } from "@sindri/director";
import { openKnowledge, SindriError } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import {
  delivery,
  escalation,
  FakeLessons,
  FakeWorld,
  OTHER,
  planProposed,
  PROJECT,
  question,
  specReview,
  testDb,
} from "./fakes.js";
import { Steward, type StewardOptions } from "./steward.js";

const rec = (value: string, confidence = 0.8, detail = "") => ({
  output: { value, detail, reasoning: "Because the blocks say so.", confidence },
});

function setup(script: FakeResponder = () => rec("Comma"), over: Partial<StewardOptions> = {}) {
  const db = testDb();
  const world = new FakeWorld();
  const provider = new FakeProvider(script);
  const knowledge = openKnowledge(db);
  const runs: { purpose: string; outcome?: string }[] = [];
  const steward = new Steward({
    db,
    world,
    provider: () => provider,
    knowledge,
    onProviderRun: (r) => runs.push(r),
    ...over,
  });
  return { db, world, provider, steward, knowledge, runs };
}

describe("decision log and recommend mode", () => {
  it("records one pending decision per subject, idempotently, with its inputs", async () => {
    const { world, steward, provider } = setup();
    world.q = [question()];
    await steward.tick();
    await steward.tick();
    const list = steward.list();
    expect(list).toHaveLength(1);
    const d = list[0]!;
    expect(d).toMatchObject({
      projectId: PROJECT,
      type: "spec.answer",
      subject: { kind: "question", id: "lin-1:Q1" },
      recommendation: { value: "Comma" },
      mode: "recommend",
      status: "pending",
      outcome: null,
      reversible: false,
      decidedAt: null,
    });
    expect(d.inputs.map((i) => i.kind)).toEqual(["spec", "question"]);
    expect(provider.calls).toHaveLength(1);
    expect(steward.get(d.id).history?.map((h) => h.action)).toEqual(["created", "recommended"]);
  });

  it("keeps history append-only and records every row change", async () => {
    const { db, world, steward } = setup();
    world.q = [question()];
    await steward.tick();
    const d = steward.list()[0]!;
    steward.reject(d.id, { reason: "We use semicolons" }, "op");
    const h = steward.get(d.id).history!;
    expect(h.map((x) => x.action)).toEqual(["created", "recommended", "rejected", "note"]);
    expect(() => db.prepare("UPDATE steward_decision_history SET actor = 'x'").run()).toThrow(
      /append-only/,
    );
  });

  it("accepts as is, accepts with an edit (changed) and rejects", async () => {
    const { world, steward } = setup((req) =>
      rec(String(req.messages[0]!.content).includes("Q2") ? "Tab" : "Comma"),
    );
    world.q = [
      question(),
      question({}, { id: "Q2", text: "Q2: header row?" }),
      question({}, { id: "Q3", text: "Quote fields?" }),
    ];
    await steward.tick();
    const [q1, q2, q3] = ["Q1", "Q2", "Q3"].map((id) =>
      steward.list().find((d) => d.subject.id.endsWith(id))!,
    );
    const a = await steward.accept(q1!.id, {}, { actor: "op" });
    expect(a).toMatchObject({ status: "accepted", appliedValue: "Comma", reversible: true });
    expect(a.decidedAt).not.toBeNull();
    const b = await steward.accept(q2!.id, { value: "Pipe" }, { actor: "op" });
    expect(b).toMatchObject({ status: "changed", appliedValue: "Pipe" });
    expect(world.calls.filter((c) => c.action === "answerQuestion").map((c) => c.args[1])).toEqual([
      "Comma",
      "Pipe",
    ]);
    const c = steward.reject(q3!.id, {}, "op");
    expect(c.status).toBe("rejected");
    await expect(steward.accept(q1!.id, {}, { actor: "op" })).rejects.toThrow(/already accepted/);
    expect(() => steward.reject(q1!.id, {}, "op")).toThrow(SindriError);
  });

  it("validates enum values and records apply failures without deciding", async () => {
    const { world, steward } = setup(() => rec("retry"));
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    await expect(steward.accept(d.id, { value: "explode" }, { actor: "op" })).rejects.toMatchObject(
      { code: "validation_failed" },
    );
    world.fail["resolveEscalation"] = new Error("mimir down");
    await expect(steward.accept(d.id, {}, { actor: "op" })).rejects.toThrow("mimir down");
    expect(steward.get(d.id).status).toBe("pending");
    expect(steward.get(d.id).history!.at(-1)!.action).toBe("apply_failed");
    delete world.fail["resolveEscalation"];
    expect((await steward.accept(d.id, { value: "skip" }, { actor: "op" })).status).toBe("changed");
  });

  it("modes are global per type, default recommend, and approvals cannot be auto", () => {
    const { steward } = setup();
    const types = steward.status().types;
    expect(types.map((t) => [t.type, t.mode, t.autoAllowed])).toEqual([
      ["spec.answer", "recommend", true],
      ["escalation.resolve", "recommend", true],
      ["rework.suggest", "recommend", true],
      ["spec.approve", "recommend", false],
      ["plan.approve", "recommend", false],
    ]);
    expect(() => steward.setMode("spec.approve", "auto", "op")).toThrow(/never applied/);
    expect(() => steward.setMode("plan.approve", "auto", "op")).toThrow(SindriError);
    expect(
      steward.setMode("spec.answer", "auto", "op").find((t) => t.type === "spec.answer")!.mode,
    ).toBe("auto");
  });

  it("mode off produces nothing for that type", async () => {
    const { world, steward } = setup();
    steward.setMode("spec.answer", "off", "op");
    world.q = [question()];
    await steward.tick();
    expect(steward.list()).toHaveLength(0);
  });

  it("lists newest first with filters and a before cursor", async () => {
    let t = Date.parse("2026-02-01T00:00:00Z");
    const { world, steward } = setup(() => rec("retry"), {
      now: () => new Date((t += 1000)),
    });
    world.e = [
      escalation(),
      escalation({ planTaskId: "T2" }),
      escalation({ projectId: OTHER, planTaskId: "T3" }),
    ];
    await steward.tick();
    const all = steward.list();
    expect(all.map((d) => d.subject.id)).toEqual(["exe-1:T3", "exe-1:T2", "exe-1:T1"]);
    expect(steward.list({ projectId: OTHER })).toHaveLength(1);
    expect(steward.list({ before: all[0]!.id }).map((d) => d.subject.id)).toEqual([
      "exe-1:T2",
      "exe-1:T1",
    ]);
    expect(steward.list({ limit: 1 })).toHaveLength(1);
    expect(steward.list({ type: "spec.answer" })).toHaveLength(0);
    expect(steward.list({ status: "pending" })).toHaveLength(3);
  });

  it("expires a pending decision whose subject is gone", async () => {
    const { world, steward } = setup();
    world.q = [question()];
    await steward.tick();
    world.q = [];
    await steward.tick();
    expect(steward.list()[0]!.status).toBe("expired");
  });

  it("notes: global, project and decision notes", async () => {
    const { world, steward } = setup();
    world.q = [question()];
    await steward.tick();
    const d = steward.list()[0]!;
    steward.addNote(null, "Prefer small changes", "op");
    steward.addNote(PROJECT, "This repo uses semicolons", "op");
    steward.addNote(OTHER, "Other project", "op");
    const withNote = steward.noteOnDecision(d.id, "Checked with the team", "op");
    expect(withNote.notes.map((n) => n.text)).toEqual(["Checked with the team"]);
    expect(
      steward
        .notes(PROJECT)
        .map((n) => n.text)
        .sort(),
    ).toEqual(
      ["Checked with the team", "Prefer small changes", "This repo uses semicolons"].sort(),
    );
    expect(steward.notes(null).map((n) => n.text)).toEqual(["Prefer small changes"]);
  });
});

describe("producers", () => {
  it("spec.answer reuses the drafter's recommendation without a provider call", async () => {
    const { world, steward, provider } = setup();
    world.q = [
      question({}, { recommendation: "Semicolon", rationale: "Excel in the EU expects it." }),
    ];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(provider.calls).toHaveLength(0);
    expect(d.recommendation.value).toBe("Semicolon");
    expect(d.reasoning).toMatch(/Excel in the EU/);
    expect(d.reasoning).toMatch(/Considered 0 note/);
  });

  it("spec.answer asks the provider with the learning context as untrusted data", async () => {
    const lessons = new FakeLessons([
      {
        id: "L1",
        title: "CSV",
        rule: "Always quote CSV fields",
        appliesWhen: null,
        paths: [],
        status: "approved",
      },
    ]);
    const { world, steward, provider } = setup(() => rec("Comma, quoted"), { lessons });
    steward.addNote(PROJECT, "Customers open exports in Excel", "op");
    world.entries = [{ projectId: PROJECT, id: "k1", claim: "Exports use CSV delimiter comma" }];
    world.q = [question()];
    await steward.tick();
    const req = provider.calls[0]!;
    expect(req.system).toMatch(/untrusted_data_/);
    expect(req.metadata?.purpose).toBe("steward_spec_answer");
    const content = String(req.messages[0]!.content);
    expect(content).toMatch(/id="fg:L1"/);
    expect(content).toMatch(/Always quote CSV fields/);
    expect(content).toMatch(/Customers open exports in Excel/);
    expect(content).toMatch(/id="knowledge:k1"/);
    const d = steward.list()[0]!;
    expect(d.inputs.map((i) => i.kind)).toEqual(["spec", "question", "note", "guidance", "lesson"]);
    expect(d.inputs.find((i) => i.kind === "lesson")!.ref).toBe("fg:L1");
  });

  it("escalation.resolve recommends one of retry/skip/replan/abort from the run context", async () => {
    const { world, steward, provider } = setup(() => rec("replan", 0.7, "The task is mis-scoped"));
    world.e = [escalation({ gateFailures: ["engineering: lint failed"] })];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d.recommendation).toEqual({ value: "replan", detail: "The task is mis-scoped" });
    expect(d.inputs.map((i) => i.kind)).toEqual(["run", "gate"]);
    expect(String(provider.calls[0]!.messages[0]!.content)).toMatch(/flaky network timeout/);
  });

  it("an escalation answer outside the enum is a provider failure", async () => {
    const { world, steward } = setup(() => rec("pray"));
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d.status).toBe("pending");
    expect(d.recommendation.value).toBe("");
    expect(d.error).toMatch(/invalid_output/);
  });

  it("rework.suggest accepts a clean delivery and asks the provider about findings", async () => {
    const { world, steward, provider } = setup(() => rec("Add a progress bar to the export page."));
    world.d = [
      delivery(),
      delivery({
        executionId: "exe-10",
        findings: [{ severity: "minor", message: "No progress feedback", role: "reviewer" }],
      }),
    ];
    await steward.tick();
    const byExe = (id: string) => steward.list().find((d) => d.subject.id === id)!;
    expect(byExe("exe-9").recommendation.value).toBe("accept");
    expect(byExe("exe-10").recommendation.value).toBe("Add a progress bar to the export page.");
    expect(byExe("exe-10").inputs.map((i) => i.kind)).toEqual(["review", "gate"]);
    expect(provider.calls).toHaveLength(1);
  });

  it("spec.approve and plan.approve hold on blockers and ask the provider otherwise", async () => {
    const { world, steward, provider } = setup(() => rec("approve", 0.8));
    world.s = [specReview(), specReview({ specId: "spec-x", blockingQuestions: ["Q1"] })];
    world.p = [planProposed(), planProposed({ planId: "plan-x", specApproved: false })];
    await steward.tick();
    const by = (id: string) => steward.list().find((d) => d.subject.id === id)!;
    expect(by("spec-2").recommendation.value).toBe("approve");
    expect(by("spec-x").recommendation).toMatchObject({ value: "hold" });
    expect(by("spec-x").reasoning).toMatch(/blocking open questions/);
    expect(by("plan-1").recommendation.value).toBe("approve");
    expect(by("plan-x").reasoning).toMatch(/not approved/);
    expect(provider.calls).toHaveLength(2);
  });

  it("accepting an approval recommendation performs it with the approval context", async () => {
    const { world, steward } = setup(() => rec("approve"));
    world.s = [specReview()];
    world.p = [planProposed()];
    await steward.tick();
    for (const d of steward.list())
      await steward.accept(d.id, {}, { actor: "local:op/web", approval: "secret" });
    expect(
      world.calls.map((c) => [c.action, (c.args.at(-1) as { approval?: string }).approval]),
    ).toEqual(
      expect.arrayContaining([
        ["approveSpec", "secret"],
        ["approvePlan", "secret"],
      ]),
    );
  });

  it("a hold accepted performs nothing", async () => {
    const { world, steward } = setup();
    world.s = [specReview({ acceptanceCriteria: 0 })];
    await steward.tick();
    const d = await steward.accept(steward.list()[0]!.id, {}, { actor: "op", approval: "s" });
    expect(d.status).toBe("accepted");
    expect(world.calls).toHaveLength(0);
  });
});

describe("learning", () => {
  it("retrieves similar past decisions with their outcomes", async () => {
    const { world, steward, provider } = setup(() => rec("skip"));
    world.e = [escalation({ planTaskId: "T1", reason: "tests failed: flaky network timeout" })];
    await steward.tick();
    const first = steward.list()[0]!;
    await steward.accept(first.id, { value: "retry" }, { actor: "op" });
    world.e = [
      escalation({ planTaskId: "T2", reason: "lint error in generated code", attempts: 1 }),
      escalation({ planTaskId: "T3", reason: "tests failed: network timeout again", attempts: 1 }),
    ];
    await steward.tick();
    const t3 = steward.list().find((d) => d.subject.id.endsWith("T3"))!;
    const past = t3.inputs.filter((i) => i.kind === "past_decision");
    expect(past[0]!.ref).toBe(`decision:${first.id}`);
    expect(past[0]!.summary).toMatch(/changed it to "retry"/);
    expect(String(provider.calls.at(-1)!.messages[0]!.content)).toMatch(
      new RegExp(`decision:${first.id}`),
    );
  });

  it("a failing lesson source yields no lessons, not a failure", async () => {
    const { world, steward } = setup(() => rec("Comma"), {
      lessons: new FakeLessons([], new Error("down")),
    });
    world.q = [question()];
    await steward.tick();
    expect(steward.list()[0]!.recommendation.value).toBe("Comma");
  });

  it("records outcomes of applied decisions when the world reports them", async () => {
    const { world, steward } = setup(() => rec("retry"));
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    await steward.accept(d.id, {}, { actor: "op" });
    world.e = [];
    world.outcomes.set("exe-1", { result: "passed", detail: "task completed" });
    await steward.tick();
    expect(steward.get(d.id).outcome).toEqual({ result: "passed", detail: "task completed" });
    world.outcomes.set("exe-1", { result: "failed" });
    await steward.tick();
    expect(steward.get(d.id).outcome).toEqual({ result: "failed" });
    const stats = steward.status().types.find((t) => t.type === "escalation.resolve")!.stats;
    expect(stats).toMatchObject({ decided: 1, accepted: 1, accuracy: 1 });
  });

  it("proposes guidance after three consistent corrections, and accepted guidance feeds later decisions", async () => {
    const { world, steward, knowledge, provider } = setup(() => rec("retry"));
    for (const n of [1, 2, 3]) {
      world.e = [escalation({ planTaskId: `T${n}`, reason: `flaky failure ${n}` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(d.id, { value: "skip" }, { actor: "op" });
      expect(steward.guidance(PROJECT)).toHaveLength(n < 3 ? 0 : 1);
    }
    const g = steward.guidance(PROJECT)[0]!;
    expect(g).toMatchObject({ status: "proposed", type: "escalation.resolve" });
    expect(g.rule).toMatch(/changed recommendations of "retry" to "skip" 3 times/);
    expect(g.decisionIds).toHaveLength(3);
    expect(knowledge.knowledge.listValid(PROJECT)).toHaveLength(0);

    const accepted = steward.decideGuidance(g.id, { decision: "accepted" }, "local:op/web");
    expect(accepted.status).toBe("accepted");
    const entry = knowledge.knowledge.get(accepted.entryId!)!;
    expect(entry.claim).toBe(g.rule);
    expect(entry.sourceRefs[0]).toHaveProperty("taskEvidenceId");
    expect(() => steward.decideGuidance(g.id, { decision: "rejected" }, "op")).toThrow(/already/);

    // The world serves approved knowledge; accepted guidance is always retrieved.
    world.entries = [{ projectId: PROJECT, id: entry.id, claim: entry.claim }];
    world.e = [escalation({ planTaskId: "T9", reason: "something else entirely" })];
    await steward.tick();
    const next = steward.list({ status: "pending" })[0]!;
    expect(next.inputs.find((i) => i.ref === `knowledge:${entry.id}`)?.summary).toMatch(
      /approved steward guidance/,
    );
    expect(String(provider.calls.at(-1)!.messages[0]!.content)).toMatch(/kind="guidance"/);
  });

  it("free-text corrections that keep adding the same terms propose guidance", async () => {
    const { world, steward } = setup(() => rec("Comma"));
    for (const n of [1, 2, 3]) {
      world.q = [question({ lineageId: `lin-${n}` }, { text: `Question ${n} about exports?` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(
        d.id,
        { value: `Comma, and confirm with finance ${n}` },
        { actor: "op" },
      );
    }
    const g = steward.guidance(PROJECT);
    expect(g).toHaveLength(1);
    expect(g[0]!.rule).toMatch(/consistently add "confirm", "finance"/);
  });

  it("names the values of a changed-value rule exactly when they contain an arrow", async () => {
    const { world, steward } = setup(() => rec("Map status -> state"));
    for (const n of [1, 2, 3]) {
      world.q = [question({ lineageId: `lin-${n}` }, { text: `Question ${n} about exports?` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(d.id, { value: "Keep status" }, { actor: "op" });
    }
    const rules = steward.guidance(PROJECT).map((x) => x.rule);
    expect(rules.filter((r) => r.includes("changed recommendations of"))).toEqual([
      expect.stringMatching(
        /changed recommendations of "Map status -> state" to "Keep status" 3 times/,
      ),
    ]);
  });

  it("corrections whose values only look alike around an arrow are not grouped", async () => {
    const recs = ["a->b", "a", "a"];
    const finals = ["c", "b->c", "b->c"];
    let i = 0;
    const { world, steward } = setup(() => rec(recs[i]!));
    for (; i < 3; i++) {
      world.q = [question({ lineageId: `lin-${i}` }, { text: `Question ${i} about exports?` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(d.id, { value: finals[i]! }, { actor: "op" });
    }
    const rules = steward.guidance(PROJECT).map((x) => x.rule);
    expect(rules.filter((r) => r.includes("changed recommendations of"))).toEqual([]);
  });

  it("rejections of one value propose guidance; rejecting a proposal records it", async () => {
    const { world, steward } = setup(() => rec("abort"));
    for (const n of [1, 2, 3]) {
      world.e = [escalation({ planTaskId: `T${n}` })];
      await steward.tick();
      steward.reject(steward.list({ status: "pending" })[0]!.id, { reason: "never abort" }, "op");
    }
    const g = steward.guidance(PROJECT)[0]!;
    expect(g.rule).toMatch(/rejected recommendations of "abort" 3 times/);
    expect(g.rule).toMatch(/never abort/);
    expect(steward.decideGuidance(g.id, { decision: "rejected", reason: "no" }, "op").status).toBe(
      "rejected",
    );
  });
});

describe("auto mode and rollback", () => {
  it("auto-applies spec.answer and rolls it back", async () => {
    const { world, steward } = setup(() => rec("Comma", 0.9));
    steward.setMode("spec.answer", "auto", "op");
    world.q = [question()];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d).toMatchObject({
      status: "applied",
      mode: "auto",
      reversible: true,
      appliedValue: "Comma",
    });
    expect(world.calls[0]!.action).toBe("answerQuestion");
    expect(steward.status().types[0]!.stats.autoApplied).toBe(1);

    const back = await steward.rollback(d.id, { reason: "wrong delimiter" }, "op");
    expect(back.status).toBe("rolled_back");
    expect(back.reversible).toBe(false);
    expect(world.calls[1]).toMatchObject({
      action: "revertAnswer",
      args: [{ lineageId: "lin-1" }, { actor: "op" }],
    });
    await expect(steward.rollback(d.id, { reason: "again" }, "op")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("a refused revert leaves the decision applied and surfaces the refusal", async () => {
    const { world, steward } = setup(() => rec("Comma", 0.9));
    steward.setMode("spec.answer", "auto", "op");
    world.q = [question()];
    await steward.tick();
    const d = steward.list()[0]!;
    world.fail["revertAnswer"] = new SindriError("invalid_state", "a later version was approved");
    await expect(steward.rollback(d.id, { reason: "x" }, "op")).rejects.toThrow(/approved/);
    expect(steward.get(d.id).status).toBe("applied");
  });

  it("auto mode skips low-confidence recommendations", async () => {
    const { world, steward } = setup(() => rec("Comma", 0.3));
    steward.setMode("spec.answer", "auto", "op");
    world.q = [question()];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d).toMatchObject({ status: "pending", mode: "recommend" });
    expect(steward.get(d.id).history!.at(-1)).toMatchObject({ action: "auto_skipped" });
  });

  it("escalation.resolve auto-applies only retry and skip, never reversibly", async () => {
    const { world, steward } = setup((req) =>
      rec(String(req.messages[0]!.content).includes("T2") ? "replan" : "retry"),
    );
    steward.setMode("escalation.resolve", "auto", "op");
    world.e = [escalation({ planTaskId: "T1" }), escalation({ planTaskId: "T2" })];
    await steward.tick();
    const by = (t: string) => steward.list().find((d) => d.subject.id.endsWith(t))!;
    expect(by("T1")).toMatchObject({ status: "applied", reversible: false });
    expect(by("T2")).toMatchObject({ status: "pending", mode: "recommend" });
    expect(world.calls.map((c) => [c.action, c.args[1]])).toEqual([["resolveEscalation", "retry"]]);
    await expect(steward.rollback(by("T1").id, { reason: "x" }, "op")).rejects.toThrow(
      /cannot be rolled back/,
    );
  });

  it("rework.suggest auto drafts the change request and rollback discards it", async () => {
    const { world, steward } = setup(() => rec("Add a progress bar.", 0.9));
    steward.setMode("rework.suggest", "auto", "op");
    world.d = [delivery({ findings: [{ severity: "minor", message: "No progress" }] })];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d).toMatchObject({ status: "applied", reversible: true });
    expect(world.calls[0]!.action).toBe("draftRework");
    expect(world.calls[0]!.args[1]).toBe("Add a progress bar.");
    await steward.rollback(d.id, { reason: "not needed" }, "op");
    expect(world.calls[1]!.action).toBe("discardRework");
    expect(world.calls[1]!.args[0]).toMatchObject({ specLineageId: "rework-lin" });
  });

  it("auto mode never applies approvals, even if the mode row says auto", async () => {
    const { db, world, steward } = setup(() => rec("approve", 0.99));
    db.prepare(
      "INSERT INTO steward_modes (type, mode, updated_by, updated_at) VALUES ('spec.approve', 'auto', 'x', 'now')",
    ).run();
    world.s = [specReview()];
    await steward.tick();
    expect(steward.list()[0]!.status).toBe("pending");
    expect(world.calls).toHaveLength(0);
  });

  it("an auto apply failure leaves a recommendation with the error", async () => {
    const { world, steward } = setup(() => rec("skip", 0.9));
    steward.setMode("escalation.resolve", "auto", "op");
    world.fail["resolveEscalation"] = new Error("mission ended");
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d).toMatchObject({ status: "pending", mode: "recommend" });
    expect(d.error).toMatch(/mission ended/);
  });
});

describe("the loop", () => {
  it("records provider failures on the decision and retries up to the attempt limit", async () => {
    const { world, steward, runs } = setup(
      () => ({ error: new ProviderError("provider_unavailable", "no CLI") }),
      { maxAttempts: 2 },
    );
    world.q = [question()];
    await steward.tick();
    let d = steward.list()[0]!;
    expect(d).toMatchObject({ status: "pending", error: "provider_unavailable: no CLI" });
    expect(d.notes[0]!.text).toMatch(/Recommendation failed \(attempt 1\)/);
    await steward.tick();
    await steward.tick();
    d = steward.list()[0]!;
    expect(d.notes).toHaveLength(2);
    expect(runs.map((r) => r.outcome)).toEqual(["provider_unavailable", "provider_unavailable"]);
  });

  it("a provider that throws synchronously never breaks the tick", async () => {
    const db = testDb();
    const world = new FakeWorld();
    const steward = new Steward({
      db,
      world,
      provider: () => {
        throw new Error("misconfigured");
      },
    });
    world.q = [question()];
    await expect(steward.tick()).resolves.toBeUndefined();
    expect(steward.list()[0]!.error).toBe("misconfigured");
  });

  it("pause stops production; resume continues", async () => {
    const { world, steward } = setup();
    steward.start();
    await steward.tick();
    expect(steward.status().running).toBe(true);
    expect(steward.pause("op").running).toBe(false);
    world.q = [question()];
    await steward.tick();
    expect(steward.list()).toHaveLength(0);
    steward.resume("op");
    await steward.tick();
    expect(steward.list()).toHaveLength(1);
    await steward.close();
  });

  it("pause survives a restart, and a restart catches up on missed subjects", async () => {
    const { db, world, provider } = setup();
    const first = new Steward({ db, world, provider: () => provider });
    first.pause("op");
    world.q = [question()];
    const second = new Steward({ db, world, provider: () => provider });
    second.start();
    await second.tick();
    expect(second.list()).toHaveLength(0);
    second.resume("op");
    await second.close();
    const third = new Steward({ db, world, provider: () => provider });
    third.start();
    await third.tick();
    expect(third.list()).toHaveLength(1);
    await third.close();
  });

  it("runs provider calls one at a time, even when ticks overlap", async () => {
    let active = 0;
    let max = 0;
    const db = testDb();
    const world = new FakeWorld();
    const slow = {
      name: "slow",
      async complete() {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return {
          text: "",
          parsed: { value: "retry", detail: "", reasoning: "r", confidence: 0.5 },
          usage: null,
          model: "slow",
          stopReason: "end",
        } as never;
      },
    };
    const steward = new Steward({ db, world, provider: () => slow });
    world.e = [1, 2, 3, 4].map((n) => escalation({ planTaskId: `T${n}` }));
    await Promise.all([steward.tick(), steward.tick(), steward.tick()]);
    expect(max).toBe(1);
    expect(
      steward.list({ status: "pending" }).every((d) => d.recommendation.value === "retry"),
    ).toBe(true);
  });

  it("purging a project deletes its steward rows", async () => {
    const { db, world, steward, knowledge } = setup();
    world.q = [question(), question({ projectId: OTHER, lineageId: "lin-o" })];
    await steward.tick();
    const mine = steward.list({ projectId: PROJECT })[0]!;
    steward.noteOnDecision(mine.id, "note", "op");
    steward.addNote(PROJECT, "project note", "op");
    steward.addNote(null, "global note", "op");
    knowledge.projects.purge(PROJECT);
    const count = (sql: string) => (db.prepare(sql).get(PROJECT) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM steward_decisions WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM steward_decision_history WHERE project_id = ?")).toBe(
      0,
    );
    expect(count("SELECT COUNT(*) AS n FROM steward_notes WHERE project_id = ?")).toBe(0);
    expect(steward.list()).toHaveLength(1);
    expect(steward.notes(null).map((n) => n.text)).toEqual(["global note"]);
  });
});

describe("auto retry guard", () => {
  it("retries a task automatically once; the next escalation of that task goes to the operator", async () => {
    const { world, steward } = setup(() => rec("retry", 0.9));
    steward.setMode("escalation.resolve", "auto", "op");
    world.e = [escalation({ attempts: 2 })];
    await steward.tick();
    world.e = [escalation({ attempts: 3 })];
    await steward.tick();
    const [second, first] = steward.list();
    expect(first!.status).toBe("applied");
    expect(second).toMatchObject({ status: "pending", mode: "recommend" });
    expect(steward.get(second!.id).history!.at(-1)!.detail).toMatchObject({
      detail: "this task was already retried automatically once",
    });
    expect(world.calls).toHaveLength(1);
  });
});
