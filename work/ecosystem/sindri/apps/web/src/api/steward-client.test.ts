import { describe, expect, it, vi } from "vitest";
import { createApiClient, type ApiClient } from "./client.js";
import { acceptNeedsApproval } from "./steward-types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SECRET = "S".repeat(43);

/** A client answering every request with `body` (and the approval session). */
function client(body: unknown = {}) {
  const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input) =>
      String(input).endsWith("/v1/approval-session")
        ? json(201, { approvalSecret: SECRET, principal: "p", expiresAt: "x" })
        : json(200, body),
  );
  const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch, newKey: () => "k" });
  const last = () => {
    const [url, init] = fetch.mock.calls.at(-1) as [string, RequestInit];
    const h = new Headers(init.headers);
    return {
      method: init.method,
      url,
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      approval: h.get("x-sindri-approval"),
      idempotency: h.get("idempotency-key"),
      auth: h.get("authorization"),
    };
  };
  return { api, last };
}

const ROUTES: {
  name: string;
  call: (api: ApiClient) => Promise<unknown>;
  response: unknown;
  sends: { method: string; url: string; body?: unknown };
  returns: unknown;
  gated?: boolean;
}[] = [
  {
    name: "stewardStatus",
    call: (api) => api.stewardStatus(),
    response: { running: true, types: [], feedbackGraph: {} },
    sends: { method: "GET", url: "/v1/steward/status" },
    returns: { running: true, types: [], feedbackGraph: {} },
  },
  {
    name: "setStewardMode",
    call: (api) => api.setStewardMode("spec.answer", "auto"),
    response: { types: [{ type: "spec.answer" }] },
    sends: { method: "PUT", url: "/v1/steward/modes", body: { type: "spec.answer", mode: "auto" } },
    returns: [{ type: "spec.answer" }],
    gated: true,
  },
  {
    name: "pauseSteward",
    call: (api) => api.pauseSteward(),
    response: { running: false },
    sends: { method: "POST", url: "/v1/steward/pause", body: {} },
    returns: { running: false },
  },
  {
    name: "resumeSteward",
    call: (api) => api.resumeSteward(),
    response: { running: true },
    sends: { method: "POST", url: "/v1/steward/resume", body: {} },
    returns: { running: true },
  },
  {
    name: "listDecisions (no filter)",
    call: (api) => api.listDecisions(),
    response: { decisions: [{ id: "d1" }] },
    sends: { method: "GET", url: "/v1/steward/decisions" },
    returns: [{ id: "d1" }],
  },
  {
    name: "listDecisions (filters)",
    call: (api) =>
      api.listDecisions({
        projectId: "p 1",
        type: "spec.answer",
        status: "pending",
        limit: 50,
        before: "d9",
      }),
    response: { decisions: [] },
    sends: {
      method: "GET",
      url: "/v1/steward/decisions?projectId=p+1&type=spec.answer&status=pending&limit=50&before=d9",
    },
    returns: [],
  },
  {
    name: "getDecision",
    call: (api) => api.getDecision("d/1"),
    response: { decision: { id: "d/1" } },
    sends: { method: "GET", url: "/v1/steward/decisions/d%2F1" },
    returns: { id: "d/1" },
  },
  {
    name: "acceptDecision (as recommended)",
    call: (api) => api.acceptDecision({ id: "d1", type: "spec.answer" }),
    response: { decision: { id: "d1" } },
    sends: { method: "POST", url: "/v1/steward/decisions/d1/accept", body: {} },
    returns: { id: "d1" },
  },
  {
    name: "acceptDecision (changed)",
    call: (api) => api.acceptDecision({ id: "d1", type: "spec.answer" }, "Use ISO dates"),
    response: { decision: { id: "d1" } },
    sends: {
      method: "POST",
      url: "/v1/steward/decisions/d1/accept",
      body: { value: "Use ISO dates" },
    },
    returns: { id: "d1" },
  },
  {
    name: "acceptDecision (approval type)",
    call: (api) => api.acceptDecision({ id: "d2", type: "plan.approve" }),
    response: { decision: { id: "d2" } },
    sends: { method: "POST", url: "/v1/steward/decisions/d2/accept", body: {} },
    returns: { id: "d2" },
    gated: true,
  },
  {
    name: "rejectDecision (no reason)",
    call: (api) => api.rejectDecision("d1"),
    response: { decision: { id: "d1" } },
    sends: { method: "POST", url: "/v1/steward/decisions/d1/reject", body: {} },
    returns: { id: "d1" },
  },
  {
    name: "rejectDecision (reason)",
    call: (api) => api.rejectDecision("d1", "wrong column"),
    response: { decision: { id: "d1" } },
    sends: {
      method: "POST",
      url: "/v1/steward/decisions/d1/reject",
      body: { reason: "wrong column" },
    },
    returns: { id: "d1" },
  },
  {
    name: "rollbackDecision",
    call: (api) => api.rollbackDecision("d1", "broke the build"),
    response: { decision: { id: "d1" } },
    sends: {
      method: "POST",
      url: "/v1/steward/decisions/d1/rollback",
      body: { reason: "broke the build" },
    },
    returns: { id: "d1" },
  },
  {
    name: "addDecisionNote",
    call: (api) => api.addDecisionNote("d1", "prefer retries"),
    response: { decision: { id: "d1" } },
    sends: {
      method: "POST",
      url: "/v1/steward/decisions/d1/notes",
      body: { text: "prefer retries" },
    },
    returns: { id: "d1" },
  },
  {
    name: "listStewardNotes (project)",
    call: (api) => api.listStewardNotes("p 1"),
    response: { notes: [{ id: "n1" }] },
    sends: { method: "GET", url: "/v1/steward/notes?projectId=p+1" },
    returns: [{ id: "n1" }],
  },
  {
    name: "listStewardNotes (all)",
    call: (api) => api.listStewardNotes(null),
    response: { notes: [] },
    sends: { method: "GET", url: "/v1/steward/notes" },
    returns: [],
  },
  {
    name: "addStewardNote (project)",
    call: (api) => api.addStewardNote("p1", "small PRs"),
    response: { note: { id: "n1" } },
    sends: {
      method: "POST",
      url: "/v1/steward/notes",
      body: { projectId: "p1", text: "small PRs" },
    },
    returns: { id: "n1" },
  },
  {
    name: "addStewardNote (global)",
    call: (api) => api.addStewardNote(null, "be careful"),
    response: { note: { id: "n2" } },
    sends: {
      method: "POST",
      url: "/v1/steward/notes",
      body: { projectId: null, text: "be careful" },
    },
    returns: { id: "n2" },
  },
  {
    name: "feedbackGraphStatus",
    call: (api) => api.feedbackGraphStatus(),
    response: { configured: false },
    sends: { method: "GET", url: "/v1/feedback-graph/status" },
    returns: { configured: false },
  },
  {
    name: "getProjectFeedbackGraph",
    call: (api) => api.getProjectFeedbackGraph("p/1"),
    response: { link: { projectKey: null, source: "none" }, lessons: [], error: null },
    sends: { method: "GET", url: "/v1/projects/p%2F1/feedback-graph" },
    returns: { link: { projectKey: null, source: "none" }, lessons: [], error: null },
  },
  {
    name: "setProjectFeedbackGraph (override)",
    call: (api) => api.setProjectFeedbackGraph("p1", "demo-app"),
    response: { link: { projectKey: "demo-app", source: "override" } },
    sends: {
      method: "PUT",
      url: "/v1/projects/p1/feedback-graph",
      body: { projectKey: "demo-app" },
    },
    returns: { link: { projectKey: "demo-app", source: "override" } },
  },
  {
    name: "setProjectFeedbackGraph (clear)",
    call: (api) => api.setProjectFeedbackGraph("p1", null),
    response: { link: { projectKey: "x", source: "auto" } },
    sends: { method: "PUT", url: "/v1/projects/p1/feedback-graph", body: { projectKey: null } },
    returns: { link: { projectKey: "x", source: "auto" } },
  },
];

describe("steward and Feedback Graph client methods", () => {
  for (const r of ROUTES)
    it(`${r.name}: ${r.sends.method} ${r.sends.url}`, async () => {
      const { api, last } = client(r.response);
      await api.unlockApprovals("ABCDE-FGH23");
      await expect(r.call(api)).resolves.toEqual(r.returns);
      const sent = last();
      expect({ method: sent.method, url: sent.url, body: sent.body }).toEqual({
        body: undefined,
        ...r.sends,
      });
      expect(sent.auth).toBe("Bearer tok");
      expect(sent.idempotency).toBe(r.sends.method === "GET" ? null : "k");
      // The approval factor goes only where the server requires it.
      expect(sent.approval).toBe(r.gated ? SECRET : null);
    });

  it("sends no approval header on gated routes before approvals are unlocked", async () => {
    const { api, last } = client({ types: [], decision: {} });
    await api.setStewardMode("spec.answer", "recommend");
    expect(last().approval).toBeNull();
    await api.acceptDecision({ id: "d1", type: "spec.approve" });
    expect(last().approval).toBeNull();
  });

  it("forgets the secret when an approval-type accept is refused for approval", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/approval-session")
        ? json(201, { approvalSecret: SECRET, principal: "p", expiresAt: "x" })
        : json(403, { error: { code: "approval_required", message: "expired" } }),
    );
    const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
    await api.unlockApprovals("ABCDE-FGH23");
    await expect(api.acceptDecision({ id: "d1", type: "spec.approve" })).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(api.hasApprovalSession()).toBe(false);
  });

  it("treats unknown decision types as approvals and known plain types as not", () => {
    expect(acceptNeedsApproval("spec.approve")).toBe(true);
    expect(acceptNeedsApproval("plan.approve")).toBe(true);
    expect(acceptNeedsApproval("delivery.export")).toBe(true);
    for (const t of ["spec.answer", "escalation.resolve", "rework.suggest"])
      expect(acceptNeedsApproval(t)).toBe(false);
  });
});
