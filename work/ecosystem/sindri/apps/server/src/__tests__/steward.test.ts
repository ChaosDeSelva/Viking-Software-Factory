import { FakeProvider, type CompleteRequest, type FakeResponse } from "@sindri/director";
import { openDatabase } from "@sindri/knowledge";
import type { Steward } from "@sindri/steward";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { demoPlanResponder } from "../demo-plan-responder.js";
import { stewardOf } from "../routes/steward.js";
import { approvedPlan, approvedSpec, startFlow, type Flow } from "./flow.js";
import { TOKEN } from "./helpers.js";
import { startMimirFlow, until } from "./mimir-flow.js";

/** What the steward's provider calls answer, per decision type (value, confidence). */
let answers: Record<string, [string, number]> = {};
const purposeType = (req: CompleteRequest) =>
  (req.metadata?.purpose ?? "").replace(/^steward_/, "").replace("_", ".");

/** The demo responders, plus scripted steward recommendations. */
function responder() {
  const demo = demoPlanResponder();
  return (req: CompleteRequest, i: number): FakeResponse => {
    if (!req.metadata?.purpose?.startsWith("steward_")) return demo(req, i);
    const [value, confidence] = answers[purposeType(req)] ?? ["", 0];
    return { output: { value, detail: "", reasoning: "Per the blocks.", confidence } };
  };
}

let f: Flow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
  answers = {};
});

async function flow(opts: Parameters<typeof startFlow>[0] = {}) {
  f = await startFlow({ providerFactory: () => new FakeProvider(responder()), ...opts });
  return f;
}
const steward = (fl: Flow): Steward => stewardOf(fl.h.app)!;
const draft = async (fl: Flow) => {
  const d = await fl.h.call({
    method: "POST",
    url: "/v1/director/draft",
    payload: { projectId: fl.projectId, request: "Add CSV export to the reports page" },
  });
  expect(d.statusCode).toBe(201);
  return d.json().spec as { id: string; lineageId: string };
};
const decisions = async (fl: Flow, q = "") => {
  const res = await fl.h.call({ url: `/v1/steward/decisions?projectId=${fl.projectId}${q}` });
  expect(res.statusCode).toBe(200);
  return res.json().decisions as {
    id: string;
    type: string;
    status: string;
    subject: { id: string };
    recommendation: { value: string };
    reversible: boolean;
    outcome: { result: string } | null;
  }[];
};
const lineage = async (fl: Flow, specId: string) =>
  (await fl.h.call({ url: `/v1/specs/${specId}` })).json().lineage as {
    id: string;
    version: number;
    status: string;
  }[];
const spec = async (fl: Flow, id: string) =>
  (await fl.h.call({ url: `/v1/specs/${id}` })).json().spec;

describe("steward routes", () => {
  it("need the bearer token and report status with the Feedback Graph status", async () => {
    const fl = await flow();
    const anon = await fl.h.app.inject({ url: "/v1/steward/status" });
    expect(anon.statusCode).toBe(401);
    const res = await fl.h.call({ url: "/v1/steward/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // A fixed test provider leaves the loop stopped unless asked for.
    expect(body.running).toBe(false);
    expect(body.types.map((t: { type: string }) => t.type)).toEqual([
      "spec.answer",
      "escalation.resolve",
      "rework.suggest",
      "spec.approve",
      "plan.approve",
    ]);
    expect(body.types[3]).toMatchObject({ mode: "recommend", autoAllowed: false });
    expect(body.types[0].stats).toEqual({
      decided: 0,
      accepted: 0,
      changed: 0,
      rejected: 0,
      rolledBack: 0,
      autoApplied: 0,
      accuracy: null,
    });
    expect(Object.keys(body.feedbackGraph).sort()).toEqual(
      expect.arrayContaining(["configured", "enabled", "error", "reachable", "url"]),
    );
  });

  it("PUT modes needs the approval factor and an Idempotency-Key, refuses auto approvals, replays", async () => {
    const fl = await flow();
    const put = (
      payload: Record<string, unknown>,
      headers: Record<string, string> = {},
      key?: string | null,
    ) =>
      fl.h.call({
        method: "PUT",
        url: "/v1/steward/modes",
        payload,
        headers,
        ...(key === undefined ? {} : { key }),
      });
    expect((await put({ type: "spec.answer", mode: "auto" })).statusCode).toBe(403);
    const approval = await fl.h.approvalHeaders();
    expect((await put({ type: "spec.answer", mode: "auto" }, approval, null)).statusCode).toBe(422);
    const auto = await put({ type: "spec.approve", mode: "auto" }, approval);
    expect(auto.statusCode).toBe(422);
    expect((await put({ type: "plan.approve", mode: "auto" }, approval)).statusCode).toBe(422);
    expect((await put({ type: "nope", mode: "auto" }, approval)).statusCode).toBe(422);
    const ok = await put({ type: "spec.answer", mode: "auto" }, approval, "mode-key-1");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().types[0].mode).toBe("auto");
    const again = await put({ type: "spec.answer", mode: "auto" }, approval, "mode-key-1");
    expect(again.headers["idempotency-replayed"]).toBe("true");
    const off = await put({ type: "spec.approve", mode: "off" }, approval);
    expect(off.json().types[3].mode).toBe("off");
  });

  it("pause and resume the loop", async () => {
    const fl = await flow({ steward: { autoStart: true, tickMs: 60_000 } });
    expect((await fl.h.call({ url: "/v1/steward/status" })).json().running).toBe(true);
    const p = await fl.h.call({ method: "POST", url: "/v1/steward/pause", payload: {} });
    expect(p.json().running).toBe(false);
    await draft(fl);
    await steward(fl).tick();
    expect(await decisions(fl)).toHaveLength(0);
    const r = await fl.h.call({ method: "POST", url: "/v1/steward/resume", payload: {} });
    expect(r.json().running).toBe(true);
    await steward(fl).tick();
    expect(await decisions(fl)).toHaveLength(2);
  });

  it("runs on events: a drafted spec nudges the loop without waiting for the periodic tick", async () => {
    const fl = await flow({ steward: { autoStart: true, tickMs: 600_000, nudgeMs: 10 } });
    await draft(fl);
    await until(
      async () => (await decisions(fl)).length,
      (n) => n === 2,
    );
  });

  it("validates queries and ids; notes are global or per project", async () => {
    const fl = await flow();
    expect((await fl.h.call({ url: "/v1/steward/decisions?projectId=nope" })).statusCode).toBe(404);
    expect((await fl.h.call({ url: "/v1/steward/decisions?type=nope" })).statusCode).toBe(422);
    expect((await fl.h.call({ url: "/v1/steward/decisions/sd_nope" })).statusCode).toBe(404);
    for (const path of ["accept", "reject", "notes"])
      expect(
        (
          await fl.h.call({
            method: "POST",
            url: `/v1/steward/decisions/sd_nope/${path}`,
            payload: path === "notes" ? { text: "x" } : {},
          })
        ).statusCode,
      ).toBe(404);
    const g = await fl.h.call({
      method: "POST",
      url: "/v1/steward/notes",
      payload: { projectId: null, text: "Prefer small changes" },
    });
    expect(g.statusCode).toBe(201);
    expect(g.json().note).toMatchObject({ projectId: null, decisionId: null, author: "user" });
    const p = await fl.h.call({
      method: "POST",
      url: "/v1/steward/notes",
      payload: { projectId: fl.projectId, text: "Reports go to finance" },
    });
    expect(p.statusCode).toBe(201);
    expect(
      (
        await fl.h.call({
          method: "POST",
          url: "/v1/steward/notes",
          payload: { projectId: "nope", text: "x" },
        })
      ).statusCode,
    ).toBe(404);
    const list = await fl.h.call({ url: `/v1/steward/notes?projectId=${fl.projectId}` });
    expect(list.json().notes.map((n: { text: string }) => n.text)).toEqual([
      "Reports go to finance",
      "Prefer small changes",
    ]);
  });
});

describe("spec.answer through the server", () => {
  it("recommends per open question, accepts (and edits) through the Director, rolls back", async () => {
    answers["spec.answer"] = ["report-YYYY-MM-DD.csv", 0.8];
    const fl = await flow();
    const sp = await draft(fl);
    await steward(fl).tick();
    await steward(fl).tick();
    const ds = await decisions(fl);
    expect(ds).toHaveLength(2);
    const q1 = ds.find((d) => d.subject.id === `${sp.lineageId}:Q1`)!;
    const q2 = ds.find((d) => d.subject.id === `${sp.lineageId}:Q2`)!;
    // Q1 reuses the drafter's recommendation; Q2 asks the provider.
    expect(q1.recommendation.value).toBe("Date, customer and total");
    expect(q2.recommendation.value).toBe("report-YYYY-MM-DD.csv");

    const a2 = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${q2.id}/accept`,
      payload: { value: "reports.csv" },
    });
    expect(a2.statusCode).toBe(200);
    expect(a2.json().decision).toMatchObject({ status: "changed", appliedValue: "reports.csv" });
    const a1 = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${q1.id}/accept`,
      payload: {},
    });
    expect(a1.json().decision).toMatchObject({ status: "accepted", reversible: true });
    let versions = await lineage(fl, sp.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    const v3 = await spec(fl, versions[2]!.id);
    expect(v3.body.openQuestions).toEqual([]);
    expect(v3.body.constraints.some((c: string) => c.includes("Date, customer and total"))).toBe(
      true,
    );

    const rb = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${q1.id}/rollback`,
      payload: { reason: "the team wants to choose" },
    });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().decision.status).toBe("rolled_back");
    versions = await lineage(fl, sp.id);
    const v4 = await spec(fl, versions.at(-1)!.id);
    expect(v4.version).toBe(4);
    expect(v4.body.openQuestions.map((q: { id: string }) => q.id)).toEqual(["Q1"]);
    expect(v4.body.constraints.some((c: string) => c.includes("Date, customer"))).toBe(false);
    expect(v4.body.constraints.some((c: string) => c.includes("reports.csv"))).toBe(true);
    // Rolled back: no second rollback; rollback needs a reason.
    const again = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${q1.id}/rollback`,
      payload: { reason: "x" },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (
        await fl.h.call({
          method: "POST",
          url: `/v1/steward/decisions/${q2.id}/rollback`,
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
    const detail = (await fl.h.call({ url: `/v1/steward/decisions/${q1.id}` })).json().decision;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual([
      "created",
      "recommended",
      "accepted",
      "rolled_back",
      "note",
    ]);
  });

  it("auto mode answers by itself; rollback is refused once a later version is approved", async () => {
    answers["spec.answer"] = ["reports.csv", 0.9];
    answers["spec.approve"] = ["approve", 0.9];
    const fl = await flow();
    const approval = await fl.h.approvalHeaders();
    await fl.h.call({
      method: "PUT",
      url: "/v1/steward/modes",
      payload: { type: "spec.answer", mode: "auto" },
      headers: approval,
    });
    const sp = await draft(fl);
    await steward(fl).tick();
    const ds = await decisions(fl);
    expect(ds.map((d) => [d.status, d.reversible])).toEqual([
      ["applied", true],
      ["applied", true],
    ]);
    const latest = (await lineage(fl, sp.id)).at(-1)!;
    expect(latest.version).toBe(3);
    expect(
      (await fl.h.call({ method: "POST", url: `/v1/specs/${latest.id}/submit`, payload: {} }))
        .statusCode,
    ).toBe(200);

    // The spec in review gets an approval recommendation; accepting it needs the factor.
    await steward(fl).tick();
    const appr = (await decisions(fl, "&type=spec.approve"))[0]!;
    expect(appr.recommendation.value).toBe("approve");
    const noFactor = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${appr.id}/accept`,
      payload: {},
    });
    expect(noFactor.statusCode).toBe(403);
    const ok = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${appr.id}/accept`,
      payload: {},
      headers: approval,
    });
    expect(ok.statusCode).toBe(200);
    expect((await spec(fl, latest.id)).status).toBe("approved");

    const rb = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${ds[0]!.id}/rollback`,
      payload: { reason: "changed my mind" },
    });
    expect(rb.statusCode).toBe(409);
    expect(rb.json().error.message).toMatch(/approved/);
  });

  it("a restarted server catches up on what happened while no steward ran", async () => {
    const fl = await flow();
    await draft(fl);
    await fl.h.app.close();
    const db = openDatabase(`${fl.h.dir}/sindri.db`);
    const app = buildServer({
      db,
      authToken: TOKEN,
      providerFactory: () => new FakeProvider(responder()),
      approval: { pairingCode: "TESTC-0DE23" },
      steward: { autoStart: true, tickMs: 60_000 },
    });
    try {
      await app.ready();
      await stewardOf(app)!.tick();
      const res = await app.inject({
        url: "/v1/steward/decisions",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().decisions).toHaveLength(2);
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("plan.approve through the server", () => {
  it("recommends on a proposed plan; accepting submits and approves it with the factor", async () => {
    answers["plan.approve"] = ["approve", 0.8];
    const fl = await flow();
    const specId = await approvedSpec(fl);
    const p = await fl.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    const planId = p.json().plan.id as string;
    await steward(fl).tick();
    const d = (await decisions(fl, "&type=plan.approve"))[0]!;
    expect(d.subject.id).toBe(planId);
    const res = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${d.id}/accept`,
      payload: {},
      headers: await fl.h.approvalHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect((await fl.h.call({ url: `/v1/plans/${planId}` })).json().plan.status).toBe("approved");
  });
});

describe("escalation.resolve with a fake Mimir", () => {
  it("auto mode retries an escalated task, the run verifies, and the outcome is recorded", async () => {
    answers["escalation.resolve"] = ["retry", 0.9];
    const fl = (f = await startMimirFlow(
      {
        qa: [
          { kind: "fail", reason: "flaky" },
          { kind: "fail", reason: "flaky" },
        ],
      },
      { providerFactory: () => new FakeProvider(responder()) },
    ));
    await fl.h.call({
      method: "PUT",
      url: "/v1/steward/modes",
      payload: { type: "escalation.resolve", mode: "auto" },
      headers: await fl.h.approvalHeaders(),
    });
    const plan = await approvedPlan(fl, await approvedSpec(fl));
    const exec = (
      await fl.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json().execution;
    const status = async () =>
      (await fl.h.call({ url: `/v1/executions/${exec.id}` })).json().execution.status as string;
    await until(status, (s) => s === "awaiting_human");
    await steward(fl).tick();
    const d = (await decisions(fl, "&type=escalation.resolve"))[0]!;
    expect(d).toMatchObject({
      status: "applied",
      reversible: false,
      recommendation: { value: "retry" },
    });
    await until(status, (s) => s === "verified_pending_review");
    const rb = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${d.id}/rollback`,
      payload: { reason: "x" },
    });
    expect(rb.statusCode).toBe(409);
    await until(
      async () => {
        await steward(fl).tick();
        return (await decisions(fl, "&type=escalation.resolve"))[0]!.outcome?.result;
      },
      (r) => r === "passed",
    );
  });
});

describe("rework.suggest with a fake Mimir", () => {
  it("suggests on a verified delivery; an edited change request drafts a rework; rollback discards it", async () => {
    answers["rework.suggest"] = ["accept", 0.7];
    const fl = (f = await startMimirFlow(
      {},
      { trustedSources: ["fake-mimir"], providerFactory: () => new FakeProvider(responder()) },
    ));
    const plan = await approvedPlan(fl, await approvedSpec(fl));
    const exec = (
      await fl.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json().execution;
    await until(
      async () => (await fl.h.call({ url: `/v1/executions/${exec.id}` })).json().execution.status,
      (s) => s === "verified_pending_review",
    );
    // The suggestion waits for the quality assessment.
    const d = await until(
      async () => {
        await steward(fl).tick();
        return (await decisions(fl, "&type=rework.suggest"))[0];
      },
      (x) => x !== undefined,
    );
    expect(d!.subject.id).toBe(exec.id);
    const res = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${d!.id}/accept`,
      payload: { value: "Use ISO dates in the export." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toMatchObject({ status: "changed", reversible: true });
    const reworks = async () =>
      (await fl.h.call({ url: `/v1/deliveries/${exec.id}/reworks` })).json().reworks as {
        feedback: string;
        specs: { status: string }[];
      }[];
    expect((await reworks()).map((r) => r.feedback)).toEqual(["Use ISO dates in the export."]);

    const rb = await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${d!.id}/rollback`,
      payload: { reason: "not needed after all" },
    });
    expect(rb.statusCode).toBe(200);
    expect(await reworks()).toEqual([]);
    // The delivery takes a new change request again.
    const again = await fl.h.call({
      method: "POST",
      url: `/v1/deliveries/${exec.id}/rework`,
      payload: { feedback: "Something else" },
    });
    expect(again.statusCode).toBe(201);
  });
});

describe("project deletion", () => {
  it("removes the project's steward rows and leaves global notes", async () => {
    answers["spec.answer"] = ["quokkasteward", 0.8];
    const fl = await flow();
    await draft(fl);
    await steward(fl).tick();
    const [d] = await decisions(fl);
    await fl.h.call({
      method: "POST",
      url: `/v1/steward/decisions/${d!.id}/notes`,
      payload: { text: "quokkanote" },
    });
    await fl.h.call({
      method: "POST",
      url: "/v1/steward/notes",
      payload: { projectId: fl.projectId, text: "quokkaproject" },
    });
    await fl.h.call({
      method: "POST",
      url: "/v1/steward/notes",
      payload: { projectId: null, text: "global stays" },
    });
    const del = await fl.h.call({
      method: "DELETE",
      url: `/v1/projects/${fl.projectId}/data`,
      payload: { confirm: "Reports" },
    });
    expect(del.statusCode).toBe(200);
    for (const t of ["steward_decisions", "steward_decision_history", "steward_guidance"])
      expect((fl.h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(
        0,
      );
    expect(fl.h.db.prepare("SELECT text FROM steward_notes").all()).toEqual([
      { text: "global stays" },
    ]);
    const commands = fl.h.db.prepare("SELECT COALESCE(response, '') AS r FROM commands").all() as {
      r: string;
    }[];
    for (const c of commands)
      for (const m of ["quokkasteward", "quokkanote", "quokkaproject"])
        expect(c.r).not.toContain(m);
  });
});
