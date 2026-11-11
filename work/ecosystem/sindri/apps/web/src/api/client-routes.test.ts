import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, type ApiClient } from "./client.js";
import type { ExecutionStreamMessage } from "./delivery-types.js";
import { parseFrame } from "./delivery-client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A client whose every request is answered with `body`; `sent()` is what went over the wire. */
function client(body: unknown = {}) {
  const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    json(200, body),
  );
  const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch, newKey: () => "k" });
  const sent = () => {
    const [url, init] = fetch.mock.calls.at(-1) as [string, RequestInit];
    return {
      method: init.method,
      url,
      ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
    };
  };
  return { api, fetch, sent };
}

afterEach(() => vi.unstubAllGlobals());

// Method, path and body per client call, as the handlers in apps/server/src/routes read them,
// and what the call hands back out of the response envelope.
const ROUTES: {
  name: string;
  call: (api: ApiClient) => Promise<unknown>;
  response: unknown;
  sends: { method: string; url: string; body?: unknown };
  returns: unknown;
}[] = [
  {
    name: "health",
    call: (api) => api.health(),
    response: { status: "ok" },
    sends: { method: "GET", url: "/v1/health" },
    returns: { status: "ok" },
  },
  {
    name: "capabilities",
    call: (api) => api.capabilities(),
    response: { serverVersion: "1", features: { mimir: true, brokkr: false } },
    sends: { method: "GET", url: "/v1/capabilities" },
    returns: { serverVersion: "1", features: { mimir: true, brokkr: false } },
  },
  {
    name: "getProject",
    call: (api) => api.getProject("p/1"),
    response: { project: { id: "p/1" } },
    sends: { method: "GET", url: "/v1/projects/p%2F1" },
    returns: { id: "p/1" },
  },
  {
    name: "bootstrap",
    call: (api) => api.bootstrap("p 1"),
    response: { result: { indexed: ["a"] } },
    sends: { method: "POST", url: "/v1/projects/p%201/bootstrap", body: {} },
    returns: { indexed: ["a"] },
  },
  {
    name: "deleteProjectData without evidence erasure",
    call: (api) => api.deleteProjectData("p1", "Demo", { eraseEvidence: false }),
    response: { deleted: { projectId: "p1" } },
    sends: { method: "DELETE", url: "/v1/projects/p1/data", body: { confirm: "Demo" } },
    returns: { deleted: { projectId: "p1" } },
  },
  {
    name: "listIntakes",
    call: (api) => api.listIntakes("p 1"),
    response: { intakes: [{ id: "i1" }] },
    sends: { method: "GET", url: "/v1/intakes?projectId=p+1" },
    returns: [{ id: "i1" }],
  },
  {
    name: "getIntake",
    call: (api) => api.getIntake("i 1"),
    response: { intake: { id: "i 1" }, comments: [] },
    sends: { method: "GET", url: "/v1/intakes/i%201" },
    returns: { intake: { id: "i 1" }, comments: [] },
  },
  {
    name: "createIntake",
    call: (api) => api.createIntake({ projectId: "p1", title: "T", body: "B" }),
    response: { intake: { id: "i1" } },
    sends: { method: "POST", url: "/v1/intakes", body: { projectId: "p1", title: "T", body: "B" } },
    returns: { id: "i1" },
  },
  {
    name: "importIntake",
    call: (api) => api.importIntake({ projectId: "p1", url: "https://x.test/T-1" }),
    response: { intake: { id: "i2" } },
    sends: {
      method: "POST",
      url: "/v1/intakes/import",
      body: { projectId: "p1", url: "https://x.test/T-1" },
    },
    returns: { id: "i2" },
  },
  {
    name: "draft",
    call: (api) => api.draft({ projectId: "p1", intakeId: "i1", request: "Add CSV" }),
    response: { spec: { id: "s1" }, meta: {}, context: [], analysis: {} },
    sends: {
      method: "POST",
      url: "/v1/director/draft",
      body: { projectId: "p1", intakeId: "i1", request: "Add CSV" },
    },
    returns: { spec: { id: "s1" }, meta: {}, context: [], analysis: {} },
  },
  {
    name: "questions",
    call: (api) => api.questions("s 1"),
    response: { questions: [{ id: "Q1" }] },
    sends: { method: "GET", url: "/v1/specs/s%201/questions" },
    returns: [{ id: "Q1" }],
  },
  {
    name: "answer",
    call: (api) => api.answer("s 1", "Q1", "Date and total"),
    response: { spec: { id: "s2" }, meta: {} },
    sends: {
      method: "POST",
      url: "/v1/specs/s%201/answer",
      body: { questionId: "Q1", answer: "Date and total" },
    },
    returns: { spec: { id: "s2" }, meta: {} },
  },
  {
    name: "getSpec",
    call: (api) => api.getSpec("s 1"),
    response: { spec: { id: "s 1" }, meta: {}, lineage: [] },
    sends: { method: "GET", url: "/v1/specs/s%201" },
    returns: { spec: { id: "s 1" }, meta: {}, lineage: [] },
  },
  {
    name: "renderSpec",
    call: (api) => api.renderSpec("s 1"),
    response: { markdown: "# T" },
    sends: { method: "GET", url: "/v1/specs/s%201/render" },
    returns: "# T",
  },
  {
    name: "diffSpecs",
    call: (api) => api.diffSpecs("s 1", "s&2"),
    response: { diff: { changed: false } },
    sends: { method: "GET", url: "/v1/specs/diff?from=s+1&to=s%262" },
    returns: { changed: false },
  },
  {
    name: "submitSpec",
    call: (api) => api.submitSpec("s 1"),
    response: { spec: { id: "s 1", status: "review" } },
    sends: { method: "POST", url: "/v1/specs/s%201/submit", body: {} },
    returns: { id: "s 1", status: "review" },
  },
  {
    name: "reviseSpec",
    call: (api) => api.reviseSpec("s 1", { title: "New", body: { problem: "P", goals: ["G"] } }),
    response: { spec: { id: "s2" }, meta: {} },
    sends: {
      method: "POST",
      url: "/v1/specs/s%201/revise",
      body: { title: "New", body: { problem: "P", goals: ["G"] } },
    },
    returns: { id: "s2" },
  },
  {
    name: "listKnowledge without a filter",
    call: (api) => api.listKnowledge("p 1"),
    response: { entries: [{ id: "k1" }] },
    sends: { method: "GET", url: "/v1/knowledge?projectId=p+1" },
    returns: [{ id: "k1" }],
  },
  {
    name: "listKnowledge with a filter",
    call: (api) => api.listKnowledge("p1", "csv & tsv"),
    response: { entries: [] },
    sends: { method: "GET", url: "/v1/knowledge?projectId=p1&q=csv+%26+tsv" },
    returns: [],
  },
  {
    name: "addKnowledge",
    call: (api) =>
      api.addKnowledge("p1", {
        claim: "C",
        sourceRefs: [{ url: "https://x.test" }],
        confidence: 1,
      }),
    response: { entry: { id: "k1" } },
    sends: {
      method: "POST",
      url: "/v1/knowledge",
      body: { projectId: "p1", claim: "C", sourceRefs: [{ url: "https://x.test" }], confidence: 1 },
    },
    returns: { id: "k1" },
  },
  {
    name: "retractKnowledge",
    call: (api) => api.retractKnowledge("k 1", "wrong"),
    response: { entry: { id: "k 1", validity: "retracted" } },
    sends: { method: "POST", url: "/v1/knowledge/k%201/retract", body: { reason: "wrong" } },
    returns: { id: "k 1", validity: "retracted" },
  },
  {
    name: "supersedeKnowledge",
    call: (api) => api.supersedeKnowledge("k 1", { claim: "C2", sourceRefs: [], confidence: 0.5 }),
    response: { entry: { id: "k2" } },
    sends: {
      method: "POST",
      url: "/v1/knowledge/k%201/supersede",
      body: { claim: "C2", sourceRefs: [], confidence: 0.5 },
    },
    returns: { id: "k2" },
  },
  {
    name: "knowledgeHistory",
    call: (api) => api.knowledgeHistory("k 1"),
    response: { history: [{ id: "k0" }, { id: "k 1" }] },
    sends: { method: "GET", url: "/v1/knowledge/k%201/history" },
    returns: [{ id: "k0" }, { id: "k 1" }],
  },
  {
    name: "getSettings",
    call: (api) => api.getSettings(),
    response: { settings: { provider: "null" }, tokenLocation: null },
    sends: { method: "GET", url: "/v1/settings" },
    returns: { settings: { provider: "null" }, tokenLocation: null },
  },
  {
    name: "putSettings",
    call: (api) => api.putSettings({ provider: "fake", model: "m", localOnly: true }),
    response: { settings: { provider: "fake", model: "m", localOnly: true } },
    sends: {
      method: "PUT",
      url: "/v1/settings",
      body: { provider: "fake", model: "m", localOnly: true },
    },
    returns: { provider: "fake", model: "m", localOnly: true },
  },
  {
    name: "requestRework",
    call: (api) => api.requestRework("e 1", "Use ISO dates"),
    response: { rework: { id: "rwk_1" }, spec: { id: "s9" } },
    sends: {
      method: "POST",
      url: "/v1/deliveries/e%201/rework",
      body: { feedback: "Use ISO dates" },
    },
    returns: { rework: { id: "rwk_1" }, spec: { id: "s9" } },
  },
  {
    name: "decideProposal",
    call: (api) => api.decideProposal("e 1", "kp/1", "rejected"),
    response: { proposal: { id: "kp/1" } },
    sends: {
      method: "POST",
      url: "/v1/deliveries/e%201/proposals/kp%2F1/decision",
      body: { decision: "rejected" },
    },
    returns: { proposal: { id: "kp/1" } },
  },
  {
    name: "proposePlan",
    call: (api) => api.proposePlan("s1"),
    response: { plan: { id: "pl1" }, versions: [], harnessSource: "fake" },
    sends: { method: "POST", url: "/v1/plans/propose", body: { specId: "s1" } },
    returns: { plan: { id: "pl1" }, versions: [], harnessSource: "fake" },
  },
  {
    name: "getPlan",
    call: (api) => api.getPlan("pl 1"),
    response: { plan: { id: "pl 1" }, versions: [] },
    sends: { method: "GET", url: "/v1/plans/pl%201" },
    returns: { plan: { id: "pl 1" }, versions: [] },
  },
  {
    name: "submitPlan",
    call: (api) => api.submitPlan("pl 1"),
    response: { plan: { id: "pl 1", status: "review" } },
    sends: { method: "POST", url: "/v1/plans/pl%201/submit", body: {} },
    returns: { id: "pl 1", status: "review" },
  },
  {
    name: "revisePlan",
    call: (api) => api.revisePlan("pl 1", []),
    response: { plan: { id: "pl2" }, versions: [] },
    sends: { method: "POST", url: "/v1/plans/pl%201/revise", body: { tasks: [] } },
    returns: { id: "pl2" },
  },
  {
    name: "listHarnesses",
    call: (api) => api.listHarnesses(),
    response: { source: "fake", harnesses: [] },
    sends: { method: "GET", url: "/v1/harnesses" },
    returns: { source: "fake", harnesses: [] },
  },
  {
    name: "getHarness",
    call: (api) => api.getHarness("front end"),
    response: { source: "fake", name: "front end", versions: [] },
    sends: { method: "GET", url: "/v1/harnesses/front%20end" },
    returns: { source: "fake", name: "front end", versions: [] },
  },
  {
    name: "repoSignals",
    call: (api) => api.repoSignals("p 1"),
    response: { signals: { packageManager: "pnpm" } },
    sends: { method: "GET", url: "/v1/harnesses/repo-signals?projectId=p+1" },
    returns: { packageManager: "pnpm" },
  },
  {
    name: "explainHarness",
    call: (api) => api.explainHarness({ task: { id: "t", title: "T", description: "D" } }),
    response: { source: "fake", selection: {}, explanation: ["because"] },
    sends: {
      method: "POST",
      url: "/v1/harnesses/explain",
      body: { task: { id: "t", title: "T", description: "D" } },
    },
    returns: { source: "fake", selection: {}, explanation: ["because"] },
  },
  {
    name: "listExecutions",
    call: (api) => api.listExecutions("p 1"),
    response: { executions: [{ id: "e1" }] },
    sends: { method: "GET", url: "/v1/executions?projectId=p+1" },
    returns: [{ id: "e1" }],
  },
  {
    name: "getExecution",
    call: (api) => api.getExecution("e 1"),
    response: { execution: { id: "e 1" } },
    sends: { method: "GET", url: "/v1/executions/e%201" },
    returns: { execution: { id: "e 1" } },
  },
  {
    name: "decideApproval with a reason",
    call: (api) => api.decideApproval("e 1", "apr/1", "rejected", "not now"),
    response: { approval: { id: "apr/1" } },
    sends: {
      method: "POST",
      url: "/v1/executions/e%201/approvals/apr%2F1",
      body: { decision: "rejected", reason: "not now" },
    },
    returns: { approval: { id: "apr/1" } },
  },
  {
    name: "resolveEscalation",
    call: (api) => api.resolveEscalation("e 1", "qa/1", "replan", "wrong approach"),
    response: { execution: { id: "e 1" } },
    sends: {
      method: "POST",
      url: "/v1/executions/e%201/escalations/qa%2F1",
      body: { decision: "replan", reason: "wrong approach" },
    },
    returns: { execution: { id: "e 1" } },
  },
  {
    name: "assessExecution",
    call: (api) => api.assessExecution("e 1"),
    response: { gates: [{ planTaskId: "qa", passed: true }] },
    sends: { method: "POST", url: "/v1/executions/e%201/assess", body: {} },
    returns: [{ planTaskId: "qa", passed: true }],
  },
  {
    name: "reviews",
    call: (api) => api.reviews("p 1"),
    response: { approvals: [] },
    sends: { method: "GET", url: "/v1/reviews?projectId=p+1" },
    returns: { approvals: [] },
  },
  {
    name: "listDeliveries",
    call: (api) => api.listDeliveries("p 1"),
    response: { deliveries: [{ id: "e1" }] },
    sends: { method: "GET", url: "/v1/deliveries?projectId=p+1" },
    returns: [{ id: "e1" }],
  },
  {
    name: "getDelivery",
    call: (api) => api.getDelivery("e 1"),
    response: { report: { id: "dlv_1" }, prDescription: "# T" },
    sends: { method: "GET", url: "/v1/deliveries/e%201" },
    returns: { report: { id: "dlv_1" }, prDescription: "# T" },
  },
  {
    name: "localDelivery",
    call: (api) => api.localDelivery("e 1"),
    response: { result: null },
    sends: { method: "GET", url: "/v1/deliveries/e%201/local" },
    returns: null,
  },
  {
    name: "deliveryTrace",
    call: (api) => api.deliveryTrace("e 1"),
    response: { trace: { schemaVersion: 1 } },
    sends: { method: "GET", url: "/v1/deliveries/e%201/trace" },
    returns: { schemaVersion: 1 },
  },
  {
    name: "mimirStatus",
    call: (api) => api.mimirStatus(),
    response: { configured: false },
    sends: { method: "GET", url: "/v1/mimir/status" },
    returns: { configured: false },
  },
];

describe("api client routes", () => {
  it.each(ROUTES)("$name", async ({ call, response, sends, returns }) => {
    const { api, sent, fetch } = client(response);
    await expect(call(api)).resolves.toEqual(returns);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual(sends);
  });

  it("downloads the export as a blob", async () => {
    const fetch = vi.fn(async () => new Response("zip-bytes", { status: 200 }));
    const api = createApiClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch });
    const blob = await api.exportData();
    expect(await blob.text()).toBe("zip-bytes");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/export");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("uses the global fetch and random idempotency keys by default, and no token header when signed out", async () => {
    const globalFetch = vi.fn(async () => json(200, { plan: { id: "pl1" } }));
    vi.stubGlobal("fetch", globalFetch);
    const api = createApiClient({ baseUrl: "", getToken: () => null });
    await api.submitPlan("pl1");
    await api.submitPlan("pl1");
    const headers = (globalFetch.mock.calls as unknown as [string, RequestInit][]).map(
      ([, init]) => new Headers(init.headers),
    );
    expect(headers[0]!.get("authorization")).toBeNull();
    expect(headers[0]!.get("content-type")).toBe("application/json");
    const keys = headers.map((h) => h.get("idempotency-key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("falls back to the status when an error response has no usable envelope", async () => {
    const answers = [
      new Response("<html>Bad gateway</html>", { status: 502 }),
      json(500, {}),
      json(422, { error: { details: [{ path: ["name"], message: "Required" }] } }),
    ];
    const fetch = vi.fn(async () => answers.shift()!);
    const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as ApiError,
      );
    const notJson = await failure(api.health());
    expect(notJson).toBeInstanceOf(ApiError);
    expect(notJson).toMatchObject({
      name: "ApiError",
      status: 502,
      code: "http_error",
      message: "Request failed (502)",
      details: undefined,
    });
    expect(await failure(api.health())).toMatchObject({
      status: 500,
      code: "http_error",
      message: "Request failed (500)",
    });
    expect(await failure(api.health())).toMatchObject({
      status: 422,
      code: "http_error",
      message: "Request failed (422)",
      details: [{ path: ["name"], message: "Required" }],
    });
  });

  it("keeps the approval session when another kind of request is refused", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/approval-session"))
        return json(201, { approvalSecret: "S", principal: "p", expiresAt: "x" });
      // An approval route failing for another reason, and a non-approval route using that code.
      if (url.endsWith("/approve"))
        return json(409, { error: { code: "invalid_state", message: "no" } });
      return json(403, { error: { code: "approval_required", message: "no" } });
    });
    const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
    await api.unlockApprovals("ABCDE-FGH23");
    await expect(api.approvePlan("pl1")).rejects.toMatchObject({ code: "invalid_state" });
    expect(api.hasApprovalSession()).toBe(true);
    await expect(api.submitPlan("pl1")).rejects.toMatchObject({ code: "approval_required" });
    expect(api.hasApprovalSession()).toBe(true);
  });
});

describe("execution stream", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const frame = (id: string) => `event: execution.event\ndata: {"id":"${id}"}\n\n`;
  const streamOf = (fetch: ReturnType<typeof vi.fn>) =>
    createApiClient({
      baseUrl: "",
      getToken: () => "tok",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

  it("parses frames: CRLF, multi-line data, comments, unknown events and broken JSON", () => {
    expect(
      parseFrame('event: execution.notice\ndata: {"type":"x",\ndata: "executionId":"e1"}'),
    ).toEqual({
      kind: "notice",
      data: { type: "x", executionId: "e1" },
    });
    expect(parseFrame('event:execution.event\ndata:{"id":"a"}')).toEqual({
      kind: "event",
      data: { id: "a" },
    });
    expect(parseFrame(": ping")).toBeNull();
    expect(parseFrame('data: {"id":"a"}')).toBeNull();
    expect(parseFrame('event: other\ndata: {"id":"a"}')).toBeNull();
    expect(parseFrame("event: execution.event")).toBeNull();
    expect(parseFrame("event: execution.event\ndata: {not json")).toBeNull();
  });

  it("reads CRLF-delimited frames and skips ones it cannot parse", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          bytes(
            'event: execution.event\r\ndata: {"id":"a"}\r\n\r\nevent: execution.event\r\ndata: oops\r\n\r\n',
          ),
        );
        c.enqueue(bytes(frame("b")));
        c.close();
      },
    });
    const got: ExecutionStreamMessage[] = [];
    await streamOf(vi.fn(async () => new Response(stream, { status: 200 }))).streamExecution(
      "e 1",
      (m) => got.push(m),
      new AbortController().signal,
    );
    expect(got).toEqual([
      { kind: "event", data: { id: "a" } },
      { kind: "event", data: { id: "b" } },
    ]);
  });

  it("returns at once when the response has no body", async () => {
    const got: ExecutionStreamMessage[] = [];
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      streamOf(fetch).streamExecution("e1", (m) => got.push(m), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(got).toEqual([]);
  });

  it("rejects with the API error when the stream cannot be opened", async () => {
    const fetch = vi.fn(async () =>
      json(401, { error: { code: "unauthorized", message: "bad token" } }),
    );
    await expect(
      streamOf(fetch).streamExecution("e1", () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("stops delivering and resolves when aborted mid-stream", async () => {
    const ctrl = new AbortController();
    let cancelled = false;
    let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        feed = c;
        c.enqueue(bytes(frame("a")));
      },
      cancel() {
        cancelled = true;
      },
    });
    const got: string[] = [];
    const done = streamOf(vi.fn(async () => new Response(stream, { status: 200 }))).streamExecution(
      "e1",
      (m) => {
        got.push((m.data as { id: string }).id);
        // Aborting from inside a delivery: the second frame of the same chunk is dropped.
        if (got.length === 2) ctrl.abort();
      },
      ctrl.signal,
    );
    await vi.waitFor(() => expect(got).toEqual(["a"]));
    feed!.enqueue(bytes(frame("b") + frame("c")));
    await expect(done).resolves.toBeUndefined();
    expect(got).toEqual(["a", "b"]);
    expect(cancelled).toBe(true);
  });

  it("rejects when the connection breaks, but not when the break follows an abort", async () => {
    const broken = () => {
      let fail: (e: Error) => void = () => undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes(frame("a")));
          fail = (e) => c.error(e);
        },
      });
      return { stream, fail: (e: Error) => fail(e) };
    };
    const first = broken();
    const got: ExecutionStreamMessage[] = [];
    const reading = streamOf(
      vi.fn(async () => new Response(first.stream, { status: 200 })),
    ).streamExecution("e1", (m) => got.push(m), new AbortController().signal);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    first.fail(new Error("connection reset"));
    await expect(reading).rejects.toThrow("connection reset");

    // Aborted first: a read that then fails is the abort's doing, not an error to report.
    const ctrl = new AbortController();
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ value: bytes(frame("a")), done: false })
        .mockImplementationOnce(async () => {
          ctrl.abort();
          throw new Error("aborted read");
        }),
      cancel: vi.fn(() => Promise.reject(new Error("already closed"))),
    };
    const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
    const seen: ExecutionStreamMessage[] = [];
    await expect(
      streamOf(vi.fn(async () => response)).streamExecution("e1", (m) => seen.push(m), ctrl.signal),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the reader when aborted while the request was in flight, even if cancelling fails", async () => {
    const ctrl = new AbortController();
    const reader = { read: vi.fn(), cancel: vi.fn(() => Promise.reject(new Error("closed"))) };
    const response = { ok: true, body: { getReader: () => reader } } as unknown as Response;
    const fetch = vi.fn(async () => {
      ctrl.abort();
      return response;
    });
    await expect(
      streamOf(fetch).streamExecution("e1", () => undefined, ctrl.signal),
    ).resolves.toBeUndefined();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.read).not.toHaveBeenCalled();
  });
});
