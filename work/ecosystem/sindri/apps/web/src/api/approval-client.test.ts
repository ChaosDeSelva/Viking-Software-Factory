import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SECRET = "S".repeat(43);

function client() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.endsWith("/v1/approval-session")
      ? json(201, { approvalSecret: SECRET, principal: "local:me/web#aps_1", expiresAt: "x" })
      : url.includes("/plans/")
        ? json(200, { plan: { id: "pl1" } })
        : url.endsWith("/pr")
          ? json(200, { pr: {} })
          : json(200, { spec: { id: "s1" }, specs: [] });
  });
  const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
  const sent = () =>
    (fetch.mock.calls as unknown as [string, RequestInit][]).map(([url, init]) => ({
      url,
      approval: new Headers(init.headers).get("x-sindri-approval"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    }));
  return { api, sent };
}

describe("approval session in the web client (audit M9)", () => {
  it("unlocks with the pairing code and keeps the secret in memory only", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { api, sent } = client();
    expect(api.hasApprovalSession()).toBe(false);
    await expect(api.unlockApprovals(" ABCDE-FGH23 ")).resolves.toMatchObject({
      principal: "local:me/web#aps_1",
    });
    expect(api.hasApprovalSession()).toBe(true);
    expect(sent()[0]).toMatchObject({
      url: "/v1/approval-session",
      body: { pairingCode: "ABCDE-FGH23", channel: "web" },
    });
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(SECRET);
    setItem.mockRestore();
  });

  it("sends the secret only on approval routes, with no free-text approver", async () => {
    const { api, sent } = client();
    await api.unlockApprovals("ABCDE-FGH23");
    await api.listSpecs("p1");
    await api.approveSpec("s1");
    await api.approveSpec("s1", { acknowledgeUntrusted: true });
    await api.approvePlan("pl1");
    await api.requestPr("e1");
    await api.decideApproval("e1", "apr_1", "approved");
    await api.deleteProjectData("p1", "Demo", { eraseEvidence: true });
    await api.proposeKnowledge("e1");
    await api.decideProposal("e1", "kp1", "accepted");
    const [, list, spec, ack, plan, pr, decide, erase, propose, proposalDecision] = sent();
    expect(list!.approval).toBeNull();
    // Agent-action decisions and evidence erasure too (review I1).
    for (const c of [spec, ack, plan, pr, decide, erase, propose, proposalDecision])
      expect(c!.approval, c!.url).toBe(SECRET);
    expect(spec!.body).toEqual({});
    expect(ack!.body).toEqual({ acknowledgeUntrusted: true });
    expect(plan!.body).toEqual({});
  });

  it("forgets the secret when the server no longer accepts it", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/approval-session")
        ? json(201, { approvalSecret: SECRET, principal: "p", expiresAt: "x" })
        : json(403, { error: { code: "approval_required", message: "expired" } }),
    );
    const api = createApiClient({ baseUrl: "", getToken: () => "tok", fetch });
    await api.unlockApprovals("ABCDE-FGH23");
    await expect(api.approveSpec("s1")).rejects.toMatchObject({ code: "approval_required" });
    expect(api.hasApprovalSession()).toBe(false);
  });
});
