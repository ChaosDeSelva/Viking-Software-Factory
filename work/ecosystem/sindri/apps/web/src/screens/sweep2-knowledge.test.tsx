import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { KnowledgeProposal } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { entry } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { KnowledgeScreen } from "./KnowledgeScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <KnowledgeScreen />
  </>
);
const DELIVERY = { id: "e1", planVersion: 2, createdAt: "2026-01-01T00:00:00Z" };
const proposal = (over: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  id: "kp1",
  claim: "Reports use papaparse",
  status: "proposed",
  sourceRefs: [{ taskEvidenceId: "ev1" }, { taskEvidenceId: "ev2" }],
  ...over,
});
const hit = (over: Record<string, unknown> = {}) => ({
  chunkId: 7,
  documentId: "d1",
  path: "README.md",
  kind: "readme",
  text: "x",
  startLine: 1,
  endLine: 3,
  score: 0,
  ...over,
});

describe("KnowledgeScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("asks for a project when none is selected", () => {
    const api = mockApi();
    renderWithStore(ui, api, { projectId: null });
    expect(screen.getByText("Create or select a project first.")).toBeTruthy();
    expect(api.listKnowledge).not.toHaveBeenCalled();
    expect(api.listDeliveries).not.toHaveBeenCalled();
  });

  it("proposes knowledge from a delivery, accepts one and rejects another", async () => {
    const api = mockApi({
      listKnowledge: [],
      listDeliveries: [DELIVERY],
      proposeKnowledge: [proposal(), proposal({ id: "kp2", claim: "Exports are UTF-8" })],
      decideProposal: {},
    });
    api.listProposals
      .mockResolvedValueOnce([
        proposal({ status: "accepted" }),
        proposal({ id: "kp2", claim: "Exports are UTF-8" }),
      ])
      .mockResolvedValueOnce([
        proposal({ status: "accepted" }),
        proposal({ id: "kp2", claim: "Exports are UTF-8", status: "rejected" }),
      ]);
    renderWithStore(ui, api);
    await screen.findByRole("option", { name: /Plan v2/ });
    await userEvent.selectOptions(screen.getByLabelText("Delivery"), "e1");
    await userEvent.click(screen.getByRole("button", { name: "Propose from delivery" }));
    expect(api.proposeKnowledge).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("Reports use papaparse")).toBeTruthy();
    expect(screen.getAllByText("proposed · 2 evidence references")).toHaveLength(2);

    const listCalls = api.listKnowledge.mock.calls.length;
    await userEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    expect(api.decideProposal).toHaveBeenCalledWith("e1", "kp1", "accepted");
    expect(await screen.findByText("accepted · 2 evidence references")).toBeTruthy();
    // Accepting adds a valid entry, so the knowledge list is loaded again.
    expect(api.listKnowledge.mock.calls.length).toBeGreaterThan(listCalls);
    // A decided proposal offers no decision buttons.
    expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(api.decideProposal).toHaveBeenLastCalledWith("e1", "kp2", "rejected");
    expect(await screen.findByText("rejected · 2 evidence references")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("drops the loaded proposals when another delivery is chosen", async () => {
    const api = mockApi({
      listKnowledge: [],
      listDeliveries: [DELIVERY, { ...DELIVERY, id: "e2", planVersion: 3 }],
      listProposals: [proposal()],
    });
    renderWithStore(ui, api);
    await screen.findByRole("option", { name: /Plan v3/ });
    await userEvent.selectOptions(screen.getByLabelText("Delivery"), "e1");
    await userEvent.click(screen.getByRole("button", { name: "Load proposals" }));
    expect(await screen.findByText("Reports use papaparse")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Delivery"), "e2");
    expect(screen.queryByText("Reports use papaparse")).toBeNull();
  });

  it("needs unlocked approvals to propose or decide, and says when they are unlocked", async () => {
    let unlocked = false;
    const api = mockApi({
      listKnowledge: [],
      listDeliveries: [DELIVERY],
      listProposals: [proposal()],
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "local:me/web#aps_1", expiresAt: "x" });
      },
    });
    renderWithStore(ui, api);
    await screen.findByRole("option", { name: /Plan v2/ });
    await userEvent.selectOptions(screen.getByLabelText("Delivery"), "e1");
    await userEvent.click(screen.getByRole("button", { name: "Load proposals" }));
    await screen.findByText("Reports use papaparse");
    expect(screen.getByRole("button", { name: "Propose from delivery" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", true);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Knowledge approvals unlocked/);
    expect(screen.getByRole("button", { name: "Accept" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Propose from delivery" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("reports a failed request and lets the person try again", async () => {
    const api = mockApi({
      listKnowledge: [],
      listDeliveries: [DELIVERY],
      listProposals: () => Promise.reject(new Error("delivery not found")),
    });
    renderWithStore(ui, api);
    await screen.findByRole("option", { name: /Plan v2/ });
    await userEvent.selectOptions(screen.getByLabelText("Delivery"), "e1");
    await userEvent.click(screen.getByRole("button", { name: "Load proposals" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/delivery not found/);
    expect(screen.getByRole("button", { name: "Load proposals" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("says no entry matches a search that finds nothing", async () => {
    const api = mockApi({ listKnowledge: [], listDeliveries: [] });
    renderWithStore(ui, api);
    await screen.findByText(/No knowledge entries yet/);
    await userEvent.type(screen.getByLabelText("Search knowledge"), "  nothing  ");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(api.listKnowledge).toHaveBeenLastCalledWith("p1", "nothing");
    expect(await screen.findByText("No entries match.")).toBeTruthy();
  });

  it("cancels a retraction without sending it", async () => {
    const api = mockApi({ listKnowledge: [entry()], listDeliveries: [] });
    renderWithStore(ui, api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Retract CSV uses papaparse" }),
    );
    const form = screen.getByRole("form", { name: "Retract entry" });
    // A blank reason is refused by the server, so it cannot be sent.
    expect(within(form).getByRole("button", { name: "Confirm retraction" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.type(within(form).getByLabelText("Reason for retraction"), "outdated");
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Retract entry" })).toBeNull();
    expect(api.retractKnowledge).not.toHaveBeenCalled();
  });

  it("lists and removes sources, labelling a cited passage by its path or document id", async () => {
    const api = mockApi({
      listKnowledge: [],
      listDeliveries: [],
      addKnowledge: entry(),
    });
    api.search
      .mockResolvedValueOnce([hit()])
      .mockResolvedValueOnce([hit({ chunkId: 8, documentId: "d2", path: "docs/b.md" })]);
    renderWithStore(ui, api);
    await userEvent.type(screen.getByLabelText("Source URL"), " https://example.com/a ");
    await userEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect((screen.getByLabelText("Source URL") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("Cite from the project index"), "csv");
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Cite README.md lines 1 to 3" }),
    );
    const sources = () =>
      screen
        .getAllByRole("button", { name: /^Remove source/ })
        .map((b) => b.parentElement!.textContent);
    expect(sources()).toEqual([
      "https://example.com/aRemove source 1",
      "README.md#L1-L3Remove source 2",
    ]);
    // A new search replaces the hits; the earlier citation falls back to its document id.
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("button", { name: "Cite docs/b.md lines 1 to 3" });
    expect(sources()[1]).toBe("d1#L1-L3Remove source 2");

    await userEvent.click(screen.getByRole("button", { name: "Remove source 1" }));
    expect(sources()).toEqual(["d1#L1-L3Remove source 1"]);
    await userEvent.type(screen.getByLabelText("Claim"), "CSV uses papaparse");
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));
    expect(api.addKnowledge).toHaveBeenCalledWith("p1", {
      claim: "CSV uses papaparse",
      sourceRefs: [{ documentId: "d1", startLine: 1, endLine: 3 }],
      confidence: 0.8,
    });
    expect(await screen.findByText("No sources yet.")).toBeTruthy();
  });

  it("refuses a confidence outside 0 to 1", async () => {
    const api = mockApi({ listKnowledge: [], listDeliveries: [] });
    renderWithStore(ui, api);
    await userEvent.type(screen.getByLabelText("Claim"), "x");
    await userEvent.type(screen.getByLabelText("Source URL"), "https://example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add URL" }));
    const conf = screen.getByLabelText("Confidence (0 to 1)");
    await userEvent.clear(conf);
    await userEvent.type(conf, "1.5");
    expect(screen.getByRole("button", { name: "Add entry" })).toHaveProperty("disabled", true);
    await userEvent.clear(conf);
    await userEvent.type(conf, "1");
    expect(screen.getByRole("button", { name: "Add entry" })).toHaveProperty("disabled", false);
  });
});
