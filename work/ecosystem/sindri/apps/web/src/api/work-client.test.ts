import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(answer: (url: string) => Response = () => json(200, {})) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.endsWith("/v1/approval-session")
      ? json(201, { approvalSecret: "SECRET", principal: "p", expiresAt: "x" })
      : answer(url);
  });
  const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
  const sent = () =>
    (fetch.mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => ({
      url,
      method: init.method,
      approval: new Headers(init.headers).get("x-sindri-approval"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }));
  return { api, sent };
}

describe("work-kind client methods", () => {
  it("sends the approval secret on accept, reject and posting a review, and on nothing else", async () => {
    const posted = { reviewId: 1, htmlUrl: "https://github.com/o/r/pull/1#r1" };
    const { api, sent } = client((url) =>
      url.endsWith("/review/post")
        ? json(200, { posted, review: { draft: {} } })
        : url.endsWith("/review/preview")
          ? json(200, { draftVersion: 2, canPost: true, blockers: [] })
          : url.endsWith("/github/status")
            ? json(200, { enabled: true, configured: true, ghInstalled: false, localOnly: false })
            : json(200, {
                report: {},
                intake: {},
                review: { draft: { version: 1 } },
                guidance: {},
              }),
    );
    await api.unlockApprovals("CODE");
    await api.acceptDocument("e1");
    await api.rejectDocument("e1", "wrong");
    await api.followUp("e1", "why?");
    expect(
      await api.saveReview("e1", { findings: [{ id: "f1", included: false, suggestion: null }] }),
    ).toEqual({ draft: { version: 1 } });
    expect(await api.previewReview("e1")).toMatchObject({ draftVersion: 2, canPost: true });
    expect((await api.postReview("e1")).posted).toEqual(posted);
    expect((await api.getReview("e1")).draft.version).toBe(1);
    expect((await api.githubStatus()).ghInstalled).toBe(false);
    const [, accept, reject, follow, save, preview, post, get, status] = sent();
    expect(accept).toMatchObject({ url: "/v1/executions/e1/accept", approval: "SECRET", body: {} });
    expect(reject).toMatchObject({ approval: "SECRET", body: { reason: "wrong" } });
    expect(follow).toMatchObject({ approval: null, body: { question: "why?" } });
    expect(save).toMatchObject({
      method: "PUT",
      url: "/v1/executions/e1/review",
      approval: null,
      body: { findings: [{ id: "f1", included: false, suggestion: null }] },
    });
    expect(preview).toMatchObject({ method: "GET", url: "/v1/executions/e1/review/preview" });
    expect(post).toMatchObject({ url: "/v1/executions/e1/review/post", approval: "SECRET" });
    expect(get).toMatchObject({ method: "GET", url: "/v1/executions/e1/review", approval: null });
    expect(status).toMatchObject({ url: "/v1/github/status" });
  });

  it("passes workKind, notes, skills and research options on intakes", async () => {
    const { api, sent } = client(() => json(201, { intake: { id: "i1" } }));
    await api.importIntake({
      url: "https://github.com/o/r/pull/3",
      workKind: "pr_review",
      skillIds: ["sk1"],
    });
    expect(sent()[0]!.body).toEqual({
      url: "https://github.com/o/r/pull/3",
      workKind: "pr_review",
      skillIds: ["sk1"],
    });
  });
});
