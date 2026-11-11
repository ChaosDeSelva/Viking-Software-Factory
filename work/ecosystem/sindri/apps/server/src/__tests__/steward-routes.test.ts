import {
  FakeProvider,
  ProviderError,
  type CompleteRequest,
  type FakeResponse,
} from "@sindri/director";
import { afterEach, describe, expect, it } from "vitest";
import { demoPlanResponder } from "../demo-plan-responder.js";
import { stewardOf } from "../routes/steward.js";
import { startFlow, type Flow } from "./flow.js";

/** What the provider does for steward calls; the demo responders answer everything else. */
let stewardReply: () => FakeResponse = () => ({
  output: { value: "", detail: "", reasoning: "", confidence: 0 },
});
function responder() {
  const demo = demoPlanResponder();
  return (req: CompleteRequest, i: number): FakeResponse =>
    req.metadata?.purpose?.startsWith("steward_") ? stewardReply() : demo(req, i);
}

let f: Flow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function flow(opts: Parameters<typeof startFlow>[0] = {}) {
  f = await startFlow({ providerFactory: () => new FakeProvider(responder()), ...opts });
  return f;
}
const draft = async (fl: Flow) => {
  const d = await fl.h.call({
    method: "POST",
    url: "/v1/director/draft",
    payload: { projectId: fl.projectId, request: "Add CSV export to the reports page" },
  });
  expect(d.statusCode).toBe(201);
};
const stewardRuns = (fl: Flow) =>
  fl.h.db
    .prepare(
      "SELECT purpose, model, outcome, input_tokens AS tokens FROM director_runs WHERE purpose LIKE 'steward_%' ORDER BY rowid",
    )
    .all();

describe("steward guidance routes", () => {
  it("list per project and are decided with the approval factor", async () => {
    const fl = await flow();
    const st = stewardOf(fl.h.app)!;
    const propose = (signature: string) =>
      st.store.proposeGuidance({
        projectId: fl.projectId,
        type: "escalation.resolve",
        signature,
        rule: `Recommend "skip" (${signature})`,
        decisionIds: [],
      })!;
    const a = propose("retry->skip");
    const b = propose("retry->abort");

    expect((await fl.h.call({ url: "/v1/steward/guidance?projectId=nope" })).statusCode).toBe(404);
    const all = await fl.h.call({ url: "/v1/steward/guidance" });
    expect(
      all
        .json()
        .guidance.map((g: { id: string }) => g.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    const mine = await fl.h.call({ url: `/v1/steward/guidance?projectId=${fl.projectId}` });
    expect(mine.json().guidance).toHaveLength(2);

    const decide = (
      id: string,
      payload: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) =>
      fl.h.call({ method: "POST", url: `/v1/steward/guidance/${id}/decision`, payload, headers });
    expect((await decide(a.id, { decision: "accepted" })).statusCode).toBe(403);
    const approval = await fl.h.approvalHeaders();
    expect((await decide(a.id, { decision: "maybe" }, approval)).statusCode).toBe(422);
    expect((await decide("sg_nope", { decision: "accepted" }, approval)).statusCode).toBe(404);

    const rejected = await decide(
      b.id,
      { decision: "rejected", reason: "abort is too drastic" },
      approval,
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().guidance).toMatchObject({ id: b.id, status: "rejected" });
    expect((await decide(b.id, { decision: "accepted" }, approval)).statusCode).toBe(409);

    const accepted = await decide(a.id, { decision: "accepted" }, approval);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().guidance.status).toBe("accepted");
    // Accepted guidance becomes a valid knowledge entry of the project.
    const k = await fl.h.call({ url: `/v1/knowledge?projectId=${fl.projectId}` });
    expect(k.json().entries.map((e: { claim: string }) => e.claim)).toEqual([
      'Recommend "skip" (retry->skip)',
    ]);
  });
});

describe("steward list and notes queries", () => {
  it("filter decisions by status, limit and cursor; notes without a project", async () => {
    stewardReply = () => ({
      output: { value: "reports.csv", detail: "", reasoning: "r", confidence: 0.5 },
    });
    const fl = await flow();
    await draft(fl);
    await stewardOf(fl.h.app)!.tick();
    const list = async (q: string) => {
      const res = await fl.h.call({ url: `/v1/steward/decisions?${q}` });
      expect(res.statusCode).toBe(200);
      return res.json().decisions as { id: string; status: string }[];
    };
    const both = await list("status=pending");
    expect(both).toHaveLength(2);
    expect(await list("status=rejected")).toEqual([]);
    const [first] = await list("limit=1");
    expect(first!.id).toBe(both[0]!.id);
    const after = await list(`before=${first!.id}`);
    expect(after.map((d) => d.id)).not.toContain(first!.id);
    expect((await fl.h.call({ url: "/v1/steward/decisions?limit=0" })).statusCode).toBe(422);

    await fl.h.call({
      method: "POST",
      url: "/v1/steward/notes",
      payload: { projectId: null, text: "Global" },
    });
    const notes = await fl.h.call({ url: "/v1/steward/notes" });
    expect(notes.json().notes.map((n: { text: string }) => n.text)).toContain("Global");
    expect((await fl.h.call({ url: "/v1/steward/notes?projectId=nope" })).statusCode).toBe(404);
  });
});

describe("steward options and cost accounting", () => {
  it("autoMinConfidence keeps a less confident auto recommendation for the operator", async () => {
    stewardReply = () => ({
      output: { value: "reports.csv", detail: "", reasoning: "r", confidence: 0.9 },
    });
    const fl = await flow({ steward: { autoMinConfidence: 0.95, nudgeMs: 5, tickMs: 60_000 } });
    await fl.h.call({
      method: "PUT",
      url: "/v1/steward/modes",
      payload: { type: "spec.answer", mode: "auto" },
      headers: await fl.h.approvalHeaders(),
    });
    await draft(fl);
    await stewardOf(fl.h.app)!.tick();
    const ds = (await fl.h.call({ url: "/v1/steward/decisions?type=spec.answer" })).json()
      .decisions as { status: string; mode: string; confidence: number }[];
    const q2 = ds.find((d) => d.confidence === 0.9)!;
    expect(q2).toMatchObject({ status: "pending", mode: "recommend" });
  });

  it("records measured provider calls and failures as Director runs, not unmeasured failures", async () => {
    let n = 0;
    stewardReply = () => {
      n++;
      if (n === 1)
        return {
          error: new ProviderError("refused", "no", {
            usage: { inputTokens: 7, outputTokens: 0 },
            model: "fake-large",
          }),
        };
      if (n === 2) return { error: new Error("socket hang up") };
      return {
        usage: { inputTokens: 11, outputTokens: 3 },
        output: { value: "reports.csv", detail: "", reasoning: "r", confidence: 0.5 },
      };
    };
    const fl = await flow();
    await draft(fl);
    const st = stewardOf(fl.h.app)!;
    await st.tick();
    await st.tick();
    await st.tick();
    expect(n).toBe(3);
    expect(stewardRuns(fl)).toEqual([
      { purpose: "steward_spec_answer", model: "fake-large", outcome: "refused", tokens: 7 },
      { purpose: "steward_spec_answer", model: "fake", outcome: "ok", tokens: 11 },
    ]);
  });
});
