import {
  FakeProvider,
  ProviderError,
  type FakeResponder,
  type LlmProvider,
} from "@sindri/director";
import { openKnowledge } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import type { ActionContext, ApplyResult, EscalationSubject } from "./ports.js";
import {
  delivery,
  escalation,
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
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const steward = new Steward({
    db,
    world,
    provider: () => provider,
    knowledge,
    logger: { warn: (msg, fields) => warnings.push({ msg, ...(fields ? { fields } : {}) }) },
    ...over,
  });
  return { db, world, provider, steward, knowledge, warnings };
}

const subjectOf = (s: Steward, task: string) => s.list().find((d) => d.subject.id.endsWith(task))!;

describe("auto mode bugs", () => {
  it("a failed auto apply is left to the operator: later ticks do not apply it again", async () => {
    const { world, steward } = setup(() => rec("skip", 0.9));
    steward.setMode("escalation.resolve", "auto", "op");
    world.fail["resolveEscalation"] = new Error("mission ended");
    world.e = [escalation()];
    await steward.tick();
    await steward.tick();
    await steward.tick();
    const d = steward.list()[0]!;
    expect(d).toMatchObject({ status: "pending", mode: "recommend" });
    expect(world.calls.filter((c) => c.action === "resolveEscalation")).toHaveLength(1);
    expect(steward.get(d.id).history!.filter((h) => h.action === "apply_failed")).toHaveLength(1);
    // The operator can still accept it once the cause is gone.
    delete world.fail["resolveEscalation"];
    expect((await steward.accept(d.id, {}, { actor: "op" })).status).toBe("accepted");
  });

  it("a decision the operator rejects while a tick awaits the provider is not auto-applied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    // T0's first recommendation fails, T1 gets one; on the next tick T0's provider call blocks.
    const provider: LlmProvider = {
      name: "scripted",
      async complete(req) {
        calls++;
        const content = String(req.messages[0]!.content);
        if (content.includes("T0")) {
          if (calls === 1) throw new ProviderError("provider_unavailable", "busy");
          await gate;
        }
        return {
          text: "",
          parsed: { value: "retry", detail: "", reasoning: "r", confidence: 0.9 } as never,
          usage: null,
          model: "m",
          stopReason: "end",
        };
      },
    };
    const db = testDb();
    const world = new FakeWorld();
    const steward = new Steward({ db, world, provider: () => provider });
    world.e = [escalation({ planTaskId: "T0" }), escalation({ planTaskId: "T1" })];
    await steward.tick();
    const t1 = subjectOf(steward, "T1");
    expect(t1.recommendation.value).toBe("retry");
    steward.setMode("escalation.resolve", "auto", "op");
    const running = steward.tick();
    // Let the tick reach T0's blocked provider call, then reject T1 meanwhile.
    while (calls < 3) await new Promise((r) => setImmediate(r));
    steward.reject(t1.id, { reason: "not this one" }, "op");
    release();
    await running;
    expect(steward.get(t1.id).status).toBe("rejected");
    expect(
      world.calls.filter(
        (c) =>
          c.action === "resolveEscalation" &&
          (c.args[0] as { planTaskId: string }).planTaskId === "T1",
      ),
    ).toHaveLength(0);
  });
});

describe("guidance from decisions without a recommendation", () => {
  it("the operator deciding subjects the steward never recommended on proposes no guidance", async () => {
    const { world, steward } = setup(() => ({
      error: new ProviderError("provider_unavailable", "no CLI"),
    }));
    for (const n of [1, 2, 3]) {
      world.e = [escalation({ planTaskId: `T${n}` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      expect(d.recommendation.value).toBe("");
      await steward.accept(d.id, { value: "skip" }, { actor: "op" });
    }
    for (const n of [4, 5, 6]) {
      world.e = [escalation({ planTaskId: `T${n}` })];
      await steward.tick();
      steward.reject(steward.list({ status: "pending" })[0]!.id, {}, "op");
    }
    expect(steward.guidance(PROJECT)).toEqual([]);
  });

  it("free-text answers given without a recommendation propose no guidance", async () => {
    const { world, steward } = setup(() => ({ error: new Error("down") }));
    for (const n of [1, 2, 3]) {
      world.q = [question({ lineageId: `lin-${n}` }, { text: `Question ${n}?` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(d.id, { value: `Confirm with finance ${n}` }, { actor: "op" });
    }
    expect(steward.guidance(PROJECT)).toEqual([]);
  });
});

/** Resolves once `cond` holds (polls the event loop; no wall-clock threshold). */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setTimeout(r, 1));
}

/** A world whose actions wait for `release()` (to observe a decision while it is applied). */
class SlowWorld extends FakeWorld {
  #gate: Promise<void> = Promise.resolve();
  release: () => void = () => {};
  hold() {
    this.#gate = new Promise((r) => (this.release = r));
  }
  override async resolveEscalation(
    s: EscalationSubject,
    decision: string,
    reason: string,
    ctx: ActionContext,
  ): Promise<ApplyResult> {
    await this.#gate;
    return super.resolveEscalation(s, decision, reason, ctx);
  }
  override async revertAnswer(applied: Record<string, unknown>, ctx: ActionContext) {
    await this.#gate;
    return super.revertAnswer(applied, ctx);
  }
}

describe("the loop's timers", () => {
  it("the periodic tick and coalesced nudges pick up new subjects; close stops both", async () => {
    const { world, steward } = setup(() => rec("Comma"), { tickMs: 5, nudgeMs: 1 });
    steward.start();
    steward.start();
    world.q = [question()];
    await until(() => steward.list().length === 1);
    world.q.push(question({ lineageId: "lin-2" }));
    steward.nudge();
    steward.nudge();
    await until(() => steward.list().length === 2);
    await steward.close();
    expect(steward.running).toBe(false);
    steward.start();
    steward.nudge();
    expect(steward.status().running).toBe(false);
    world.q.push(question({ lineageId: "lin-3" }));
    await steward.tick();
    expect(steward.list()).toHaveLength(2);
  });

  it("close gives up waiting for a tick that runs longer than closeWaitMs", async () => {
    const provider: LlmProvider = { name: "never", complete: () => new Promise(() => {}) };
    const db = testDb();
    const world = new FakeWorld();
    const steward = new Steward({ db, world, provider: () => provider });
    world.q = [question()];
    void steward.tick();
    await until(() => steward.list().length === 1);
    await expect(steward.close(1)).resolves.toBeUndefined();
  });

  it("a cycle that throws is logged and the next tick still runs", async () => {
    const { world, steward, warnings } = setup();
    // An unknown project violates the decisions' foreign key: the whole cycle fails.
    world.q = [question({ projectId: "prj_unknown" })];
    await expect(steward.tick()).resolves.toBeUndefined();
    expect(warnings.map((w) => w.msg)).toContain("steward tick failed");
    world.q = [question()];
    await steward.tick();
    expect(steward.list()).toHaveLength(1);
  });

  it("a failing subject reader skips its type and does not expire its decisions", async () => {
    const { world, steward, warnings } = setup();
    world.q = [question()];
    world.e = [escalation()];
    await steward.tick();
    world.questions = () => {
      throw new Error("specs unavailable");
    };
    world.e = [];
    await steward.tick();
    expect(warnings).toContainEqual({
      msg: "steward could not read subjects",
      fields: { type: "spec.answer", err: "specs unavailable" },
    });
    expect(steward.list({ type: "spec.answer" })[0]!.status).toBe("pending");
    expect(steward.list({ type: "escalation.resolve" })[0]!.status).toBe("expired");
  });

  it("stops between decisions when paused mid-cycle", async () => {
    const ref: { steward?: Steward } = {};
    const provider: LlmProvider = {
      name: "pausing",
      complete() {
        ref.steward!.pause("op");
        return Promise.resolve({
          text: "",
          parsed: { value: "retry", detail: "", reasoning: "r", confidence: 0.9 } as never,
          usage: null,
          model: "m",
          stopReason: "end",
        });
      },
    };
    const world = new FakeWorld();
    const steward = (ref.steward = new Steward({ db: testDb(), world, provider: () => provider }));
    world.e = [escalation({ planTaskId: "T1" }), escalation({ planTaskId: "T2" })];
    await steward.tick();
    expect(
      steward
        .list()
        .map((d) => d.recommendation.value)
        .sort(),
    ).toEqual(["", "retry"]);
  });

  it("does not auto-apply a recommendation that arrives after the operator paused", async () => {
    const ref: { steward?: Steward } = {};
    const provider: LlmProvider = {
      name: "pausing",
      complete() {
        ref.steward!.pause("op");
        return Promise.resolve({
          text: "",
          parsed: { value: "retry", detail: "", reasoning: "r", confidence: 0.9 } as never,
          usage: null,
          model: "m",
          stopReason: "end",
        });
      },
    };
    const world = new FakeWorld();
    const steward = (ref.steward = new Steward({ db: testDb(), world, provider: () => provider }));
    steward.setMode("escalation.resolve", "auto", "op");
    world.e = [escalation()];
    await steward.tick();
    expect(world.calls).toEqual([]);
    expect(steward.list()[0]).toMatchObject({
      status: "pending",
      recommendation: { value: "retry" },
    });
  });

  it("does not auto-apply a recommendation that arrives after close", async () => {
    const ref: { steward?: Steward } = {};
    const provider: LlmProvider = {
      name: "closing",
      complete() {
        void ref.steward!.close(0);
        return Promise.resolve({
          text: "",
          parsed: { value: "retry", detail: "", reasoning: "r", confidence: 0.9 } as never,
          usage: null,
          model: "m",
          stopReason: "end",
        });
      },
    };
    const world = new FakeWorld();
    const steward = (ref.steward = new Steward({ db: testDb(), world, provider: () => provider }));
    steward.setMode("escalation.resolve", "auto", "op");
    world.e = [escalation()];
    await steward.tick();
    expect(world.calls).toEqual([]);
  });
});

describe("recommendation failures", () => {
  const custom = (complete: LlmProvider["complete"]) => {
    const db = testDb();
    const world = new FakeWorld();
    const runs: { model: string; usage: unknown; outcome?: string }[] = [];
    const steward = new Steward({
      db,
      world,
      provider: () => ({ name: "custom", complete }),
      onProviderRun: (r) => runs.push(r),
    });
    return { world, steward, runs };
  };

  it("a result without structured output is an invalid_output failure, billed to its model", async () => {
    const usage = { inputTokens: 3, outputTokens: 1 };
    const { world, steward, runs } = custom(() =>
      Promise.resolve({ text: "hi", usage, model: "m-1", stopReason: "end" }),
    );
    world.q = [question()];
    await steward.tick();
    expect(steward.list()[0]!.error).toBe("invalid_output: missing structured output");
    expect(runs).toEqual([
      {
        projectId: PROJECT,
        purpose: "steward_spec_answer",
        model: "m-1",
        usage,
        outcome: "invalid_output",
      },
    ]);
  });

  it("a non-Error rejection is recorded as its text", async () => {
    const { world, steward, runs } = custom(() =>
      Promise.reject("socket hang up" as unknown as Error),
    );
    world.q = [question()];
    await steward.tick();
    expect(steward.list()[0]!.error).toBe("socket hang up");
    expect(runs[0]).toMatchObject({ model: "unknown", usage: null, outcome: "error" });
  });

  it("an empty detail from the provider is stored as no detail", async () => {
    const { world, steward } = setup(() => rec("retry", 0.5, "   "));
    world.e = [escalation()];
    await steward.tick();
    expect(steward.list()[0]!.recommendation).toEqual({ value: "retry" });
  });

  it("stops asking the provider after maxProviderCallsPerTick calls in one tick", async () => {
    const { world, steward, provider } = setup(() => rec("retry"), { maxProviderCallsPerTick: 1 });
    world.e = [escalation({ planTaskId: "T1" }), escalation({ planTaskId: "T2" })];
    await steward.tick();
    expect(provider.calls).toHaveLength(1);
    await steward.tick();
    expect(provider.calls).toHaveLength(2);
  });

  it("a decision the operator decides during its provider call keeps the operator's decision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const provider: LlmProvider = {
      name: "slow",
      async complete() {
        started = true;
        await gate;
        throw new ProviderError("provider_unavailable", "late failure");
      },
    };
    const world = new FakeWorld();
    const steward = new Steward({ db: testDb(), world, provider: () => provider });
    world.e = [escalation()];
    const running = steward.tick();
    await until(() => started);
    const d = steward.list()[0]!;
    await steward.accept(d.id, { value: "skip" }, { actor: "op" });
    release();
    await running;
    const after = steward.get(d.id);
    expect(after).toMatchObject({ status: "changed", appliedValue: "skip", error: null });
    expect(after.notes).toEqual([]);
  });
});

describe("operator actions: refusals", () => {
  it("accepting a decision without a recommendation needs a value", async () => {
    const { world, steward } = setup(() => ({ error: new Error("down") }));
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    await expect(steward.accept(d.id, {}, { actor: "op" })).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/no recommendation yet/),
    });
    await expect(steward.accept(d.id, { value: "  " }, { actor: "op" })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("refuses to accept, reject or roll back a decision while it is being applied", async () => {
    const db = testDb();
    const world = new SlowWorld();
    const steward = new Steward({
      db,
      world,
      provider: () => new FakeProvider(() => rec("retry")),
    });
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    world.hold();
    const first = steward.accept(d.id, {}, { actor: "op" });
    await expect(steward.accept(d.id, {}, { actor: "op" })).rejects.toThrow(/being applied/);
    expect(() => steward.reject(d.id, {}, "op")).toThrow(/being applied/);
    world.release();
    expect((await first).status).toBe("accepted");
  });

  it("refuses a second rollback while the first is undoing the decision", async () => {
    const db = testDb();
    const world = new SlowWorld();
    const steward = new Steward({
      db,
      world,
      provider: () => new FakeProvider(() => rec("Comma")),
    });
    world.q = [question()];
    await steward.tick();
    const d = await steward.accept(steward.list()[0]!.id, {}, { actor: "op" });
    world.hold();
    const first = steward.rollback(d.id, { reason: "wrong" }, "op");
    await expect(steward.rollback(d.id, { reason: "again" }, "op")).rejects.toThrow(
      /being changed right now/,
    );
    world.release();
    expect((await first).status).toBe("rolled_back");
  });

  it("unknown ids are not_found everywhere", async () => {
    const { steward } = setup();
    const nf = { code: "not_found" };
    expect(() => steward.get("sd_x")).toThrow(expect.objectContaining(nf));
    await expect(steward.accept("sd_x", {}, { actor: "op" })).rejects.toMatchObject(nf);
    expect(() => steward.reject("sd_x", {}, "op")).toThrow(expect.objectContaining(nf));
    await expect(steward.rollback("sd_x", { reason: "r" }, "op")).rejects.toMatchObject(nf);
    expect(() => steward.noteOnDecision("sd_x", "t", "op")).toThrow(expect.objectContaining(nf));
    expect(() => steward.decideGuidance("sg_x", { decision: "accepted" }, "op")).toThrow(
      expect.objectContaining(nf),
    );
  });

  it("rollback refuses decisions that are pending or performed nothing undoable", async () => {
    const { world, steward } = setup(() => rec("approve"));
    world.s = [specReview({ acceptanceCriteria: 0 })];
    world.e = [escalation()];
    await steward.tick();
    const hold = steward.list({ type: "spec.approve" })[0]!;
    await expect(steward.rollback(hold.id, { reason: "r" }, "op")).rejects.toThrow(
      /was not applied \(it is pending\)/,
    );
    await steward.accept(hold.id, {}, { actor: "op", approval: "s" });
    await expect(steward.rollback(hold.id, { reason: "r" }, "op")).rejects.toThrow(
      /it changed nothing that can be undone/,
    );
  });

  it("a reversible result of a type that has no undo is refused at rollback", async () => {
    class ReversibleEscalations extends FakeWorld {
      override async resolveEscalation() {
        return { reversible: true, data: { executionId: "exe-1" } };
      }
    }
    const world = new ReversibleEscalations();
    const steward = new Steward({
      db: testDb(),
      world,
      provider: () => new FakeProvider(() => rec("retry")),
    });
    world.e = [escalation()];
    await steward.tick();
    const d = await steward.accept(steward.list()[0]!.id, {}, { actor: "op" });
    expect(d.reversible).toBe(true);
    await expect(steward.rollback(d.id, { reason: "r" }, "op")).rejects.toThrow(
      /escalation.resolve decisions cannot be rolled back/,
    );
    expect(steward.get(d.id).status).toBe("accepted");
  });

  it("accepting guidance needs the knowledge store", async () => {
    const db = testDb();
    const world = new FakeWorld();
    const steward = new Steward({
      db,
      world,
      provider: () => new FakeProvider(() => rec("abort")),
    });
    const g = steward.store.proposeGuidance({
      projectId: PROJECT,
      type: "escalation.resolve",
      signature: "rejected:abort",
      rule: "Do not abort.",
      decisionIds: [],
    })!;
    expect(() => steward.decideGuidance(g.id, { decision: "accepted" }, "op")).toThrow(
      /knowledge is not available/,
    );
    expect(steward.decideGuidance(g.id, { decision: "rejected" }, "op")).toMatchObject({
      status: "rejected",
      reason: null,
    });
  });

  it("accepted guidance cites decisions that no longer exist by id only", () => {
    const { steward, knowledge } = setup();
    const g = steward.store.proposeGuidance({
      projectId: PROJECT,
      type: "escalation.resolve",
      signature: "rejected:abort",
      rule: "Do not abort.",
      decisionIds: ["sd_gone"],
    })!;
    const done = steward.decideGuidance(g.id, { decision: "accepted", reason: "agreed" }, "op");
    expect(done).toMatchObject({ status: "accepted", reason: "agreed", decidedBy: "op" });
    const entry = knowledge.knowledge.get(done.entryId!)!;
    const evidence = knowledge.evidence.get(
      (entry.sourceRefs[0] as { taskEvidenceId: string }).taskEvidenceId,
    )!;
    expect(evidence.payload).toMatchObject({ decisions: [{ id: "sd_gone" }] });
  });
});

describe("applying values", () => {
  it("accepting a delivery as is, or holding a plan, performs nothing", async () => {
    const { world, steward } = setup(() => rec("hold"));
    world.d = [delivery()];
    world.p = [planProposed()];
    await steward.tick();
    for (const d of steward.list())
      expect((await steward.accept(d.id, {}, { actor: "op", approval: "s" })).status).toBe(
        "accepted",
      );
    expect(world.calls).toEqual([]);
  });

  it("the escalation reason is the detail, else the reasoning, else the value, clipped", async () => {
    const long = "x".repeat(3000);
    const { world, steward } = setup((req) => {
      const c = String(req.messages[0]!.content);
      if (c.includes("T1")) return rec("retry", 0.8, long);
      return { output: { value: "skip", detail: "", reasoning: "Flaky.", confidence: 0.8 } };
    });
    world.e = [escalation({ planTaskId: "T1" }), escalation({ planTaskId: "T2" })];
    await steward.tick();
    for (const d of steward.list()) await steward.accept(d.id, {}, { actor: "op" });
    const reasons = world.calls.map((c) => c.args[2] as string);
    expect(reasons.find((r) => r.includes("xxx"))).toHaveLength(2000);
    expect(reasons.find((r) => r.includes("xxx"))!.endsWith("…")).toBe(true);
    expect(reasons).toContainEqual(expect.stringMatching(/: Flaky\.$/));
  });
});

describe("heuristics with learning", () => {
  it("a drafter suggestion gains confidence from similar accepted answers and names guidance", async () => {
    const { world, steward, knowledge } = setup();
    const suggestion = { recommendation: "Comma" };
    world.q = [question({ lineageId: "lin-a" }, suggestion)];
    await steward.tick();
    await steward.accept(steward.list()[0]!.id, {}, { actor: "op" });
    const g = steward.store.proposeGuidance({
      projectId: PROJECT,
      type: "spec.answer",
      signature: "terms:quote",
      rule: "Quote every CSV field.",
      decisionIds: [],
    })!;
    const accepted = steward.decideGuidance(g.id, { decision: "accepted" }, "op");
    world.entries = [
      { projectId: PROJECT, id: accepted.entryId!, claim: "Quote every CSV field." },
    ];
    expect(knowledge.knowledge.get(accepted.entryId!)).toBeDefined();
    world.q = [question({ lineageId: "lin-b" }, suggestion)];
    await steward.tick();
    const d = steward.list({ status: "pending" })[0]!;
    expect(d.confidence).toBeCloseTo(0.7);
    expect(d.reasoning).toMatch(/1 similar past recommendation\(s\) were accepted/);
    expect(d.reasoning).toMatch(/Approved steward guidance for this project applies/);
    expect(d.reasoning).toMatch(/1 knowledge entry and/);
  });

  it("a drafter suggestion goes to the provider when a similar past answer was corrected", async () => {
    const { world, steward, provider } = setup(() => rec("Semicolon"));
    const suggestion = { recommendation: "Comma", rationale: "Most tools expect it." };
    world.q = [question({ lineageId: "lin-a" }, suggestion)];
    await steward.tick();
    await steward.accept(steward.list()[0]!.id, { value: "Semicolon" }, { actor: "op" });
    world.q = [question({ lineageId: "lin-b" }, suggestion)];
    await steward.tick();
    expect(provider.calls).toHaveLength(1);
    const content = String(provider.calls[0]!.messages[0]!.content);
    expect(content).toMatch(/id="drafter-suggestion"/);
    expect(content).toMatch(/Most tools expect it/);
    expect(steward.list({ status: "pending" })[0]!.recommendation.value).toBe("Semicolon");
  });
});

describe("outcomes", () => {
  it("a world that cannot read an outcome is logged and the others are still recorded", async () => {
    const { world, steward, warnings } = setup(() => rec("retry"));
    world.e = [escalation({ planTaskId: "T1" }), escalation({ planTaskId: "T2" })];
    await steward.tick();
    for (const d of steward.list()) await steward.accept(d.id, {}, { actor: "op" });
    world.e = [];
    const base = world.outcome.bind(world);
    world.outcome = (input) => {
      if (JSON.stringify(input.context).includes('"T1"')) throw new Error("db locked");
      return base(input);
    };
    world.outcomes.set("T2", { result: "passed" });
    await steward.tick();
    expect(warnings.map((w) => w.msg)).toContain("steward could not read an outcome");
    expect(subjectOf(steward, "T2").outcome).toEqual({ result: "passed" });
    expect(subjectOf(steward, "T1").outcome).toBeNull();
    const before = steward.get(subjectOf(steward, "T2").id).history!.length;
    await steward.tick();
    expect(steward.get(subjectOf(steward, "T2").id).history).toHaveLength(before);
  });
});

describe("corrections and guidance rules", () => {
  it("rework text edits are not a change of kind; rejected answers group under one rule", async () => {
    const { world, steward } = setup(() => rec("Add tests."));
    for (const [n, text] of [
      [1, "Rename helpers."],
      [2, "Split the parser."],
      [3, "Document flags."],
    ] as const) {
      world.d = [
        delivery({ executionId: `exe-${n}`, findings: [{ severity: "minor", message: "m" }] }),
      ];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      await steward.accept(d.id, { value: text }, { actor: "op" });
    }
    expect(steward.guidance(PROJECT)).toEqual([]);

    for (const n of [1, 2, 3]) {
      world.q = [question({ lineageId: `lin-${n}` }, { text: `Unrelated question ${n}?` })];
      await steward.tick();
      steward.reject(steward.list({ status: "pending", type: "spec.answer" })[0]!.id, {}, "op");
    }
    const [g] = steward.guidance(PROJECT);
    expect(g!.type).toBe("spec.answer");
    expect(g!.rule).toMatch(/rejected 3 recommendations/);
    expect(g!.rule).toMatch(/Leave such decisions to the operator/);
    expect(g!.rule).not.toMatch(/Operator reasons/);
  });

  it("rolled-back decisions count as corrections and the rule is proposed once", async () => {
    const { world, steward } = setup(() => rec("Comma", 0.9));
    steward.setMode("spec.answer", "auto", "op");
    for (const n of [1, 2, 3, 4]) {
      world.q = [question({ lineageId: `lin-${n}` }, { text: `Delimiter ${n}?` })];
      await steward.tick();
      const d = steward.list({ type: "spec.answer" })[0]!;
      expect(d.status).toBe("applied");
      await steward.rollback(d.id, { reason: `wrong ${n}` }, "op");
    }
    const g = steward.guidance(PROJECT);
    expect(g).toHaveLength(1);
    expect(g[0]!.decisionIds).toHaveLength(3);
    expect(g[0]!.rule).toMatch(/Operator reasons: Rolled back: wrong/);
  });

  it("guidance from corrections in one project does not count another project's", async () => {
    const { world, steward } = setup(() => rec("abort"));
    for (const [n, projectId] of [
      [1, PROJECT],
      [2, OTHER],
      [3, PROJECT],
    ] as const) {
      world.e = [escalation({ planTaskId: `T${n}`, projectId })];
      await steward.tick();
      steward.reject(steward.list({ status: "pending" })[0]!.id, {}, "op");
    }
    expect(steward.guidance()).toEqual([]);
  });
});

describe("more guidance and loop branches", () => {
  it("changing an accept-as-is recommendation into change requests proposes guidance", async () => {
    const { world, steward } = setup();
    for (const [n, text] of [
      [1, "Rename helpers."],
      [2, "Split the parser."],
      [3, "Document flags."],
    ] as const) {
      world.d = [delivery({ executionId: `exe-${n}` })];
      await steward.tick();
      const d = steward.list({ status: "pending" })[0]!;
      expect(d.recommendation.value).toBe("accept");
      await steward.accept(d.id, { value: text }, { actor: "op" });
    }
    const [g] = steward.guidance(PROJECT);
    expect(g!.rule).toMatch(/changed recommendations of "accept" to "change" 3 times/);
  });

  it("learning limits apply to recommendations", async () => {
    const { world, steward } = setup(() => rec("Comma"), { limits: { globalNotes: 0 } });
    steward.addNote(null, "Global preference", "op");
    world.q = [question()];
    await steward.tick();
    expect(steward.list()[0]!.inputs.map((i) => i.kind)).toEqual(["spec", "question"]);
  });

  it("a recommendation already left to the operator is not skipped again on later ticks", async () => {
    const { world, steward } = setup(() => rec("Comma", 0.3));
    steward.setMode("spec.answer", "auto", "op");
    world.q = [question()];
    await steward.tick();
    await steward.tick();
    const actions = steward.get(steward.list()[0]!.id).history!.map((h) => h.action);
    expect(actions).toEqual(["created", "recommended", "auto_skipped"]);
  });

  it("accepting fails cleanly when the project is purged while the action runs", async () => {
    const db = testDb();
    const world = new SlowWorld();
    const knowledge = openKnowledge(db);
    const steward = new Steward({
      db,
      world,
      provider: () => new FakeProvider(() => rec("retry")),
    });
    world.e = [escalation()];
    await steward.tick();
    const d = steward.list()[0]!;
    world.hold();
    const accepting = steward.accept(d.id, {}, { actor: "op" });
    knowledge.projects.purge(PROJECT);
    world.release();
    await expect(accepting).rejects.toThrow(/changed meanwhile/);
  });

  it("rolling back fails cleanly when the project is purged while the undo runs", async () => {
    const db = testDb();
    const world = new SlowWorld();
    const knowledge = openKnowledge(db);
    const steward = new Steward({
      db,
      world,
      provider: () => new FakeProvider(() => rec("Comma")),
    });
    world.q = [question()];
    await steward.tick();
    const d = await steward.accept(steward.list()[0]!.id, {}, { actor: "op" });
    world.hold();
    const rolling = steward.rollback(d.id, { reason: "r" }, "op");
    knowledge.projects.purge(PROJECT);
    world.release();
    await expect(rolling).rejects.toThrow(/changed meanwhile/);
  });
});
