import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { meta, spec } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { latestPerLineage, SpecsScreen } from "./SpecsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <SpecsScreen />
  </>
);
const v1 = spec();
const v2 = spec({ id: "s2", version: 2, createdAt: "2026-01-02T00:00:00Z" });
const lineage = [v1, v2].map((s) => ({
  id: s.id,
  version: s.version,
  status: s.status,
  title: s.title,
  createdAt: s.createdAt,
}));

describe("SpecsScreen", () => {
  it("groups versions by lineage", () => {
    expect(latestPerLineage([v1, v2]).map((s) => [s.id, s.versions])).toEqual([["s2", 2]]);
  });

  it("shows the empty state", async () => {
    renderWithStore(ui, mockApi({ listSpecs: [] }));
    expect(await screen.findByText(/No specs yet/)).toBeTruthy();
  });

  it("explains the blocking-question guard and keeps approve disabled", async () => {
    const inReview = spec({ status: "review" });
    const api = mockApi({
      listSpecs: [inReview],
      getSpec: { spec: inReview, meta: meta(), lineage: lineage.slice(0, 1) },
    });
    renderWithStore(ui, api, { specId: "s1" });
    expect(
      await screen.findByText(/Approval is blocked: 1 blocking open question \(Q1\)/),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("submits a draft and approves a spec in review", async () => {
    const draft = spec({ body: { ...spec().body, openQuestions: [] } });
    const review = { ...draft, status: "review" as const };
    const approved = { ...draft, status: "approved" as const, approvedBy: "local user" };
    const api = mockApi({
      listSpecs: [draft],
      getSpec: { spec: draft, meta: meta(), lineage: lineage.slice(0, 1) },
      submitSpec: review,
      approveSpec: approved,
    });
    api.getSpec
      .mockResolvedValueOnce({ spec: draft, meta: meta(), lineage: lineage.slice(0, 1) })
      .mockResolvedValue({ spec: review, meta: meta(), lineage: lineage.slice(0, 1) });
    renderWithStore(ui, api, { specId: "s1" });
    await userEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    expect(api.submitSpec).toHaveBeenCalledWith("s1");
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(api.approveSpec).toHaveBeenCalledWith("s1", {});
    expect((await screen.findByRole("status")).textContent).toMatch(/Approved v1/);
  });

  it("asks for the pairing code before approving (audit M9)", async () => {
    const review = spec({ status: "review", body: { ...spec().body, openQuestions: [] } });
    let unlocked = false;
    const api = mockApi({
      listSpecs: [review],
      getSpec: { spec: review, meta: meta(), lineage: lineage.slice(0, 1) },
      approveSpec: { ...review, status: "approved" },
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "local:me/web#aps_1", expiresAt: "x" });
      },
    });
    renderWithStore(ui, api, { specId: "s1" });
    const approve = (await screen.findByRole("button", { name: "Approve" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.queryByLabelText("Approver")).toBeNull();
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(api.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(api.approveSpec).toHaveBeenCalledWith("s1", {});
  });

  it("requires acknowledging flagged instructions before approving (audit M9)", async () => {
    const review = spec({ status: "review", body: { ...spec().body, openQuestions: [] } });
    const api = mockApi({
      listSpecs: [review],
      getSpec: {
        spec: review,
        meta: meta({ untrustedInstructionDetected: true }),
        lineage: lineage.slice(0, 1),
      },
      approveSpec: { ...review, status: "approved" },
    });
    renderWithStore(ui, api, { specId: "s1" });
    const approve = (await screen.findByRole("button", { name: "Approve" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await userEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the flagged instructions/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.approveSpec).toHaveBeenCalledWith("s1", { acknowledgeUntrusted: true });
  });

  it("compares two versions with a structured diff and renders markdown", async () => {
    const api = mockApi({
      listSpecs: [v1, v2],
      getSpec: { spec: v2, meta: meta(), lineage },
      diffSpecs: {
        from: "s1",
        to: "s2",
        changed: true,
        goals: { added: [], removed: [] },
        nonGoals: { added: [], removed: [] },
        constraints: { added: ["Which columns? Answer: All"], removed: [] },
        risks: { added: [], removed: [] },
        assumptions: { added: [], removed: [], changed: [] },
        acceptanceCriteria: { added: [], removed: [], changed: [] },
        openQuestions: {
          added: [],
          removed: [{ id: "Q1", text: "Which columns?", blocking: true }],
          changed: [],
        },
      },
      renderSpec: "# CSV export for reports",
    });
    renderWithStore(ui, api, { specId: "s2" });
    const versions = await screen.findByRole("navigation", { name: "Versions" });
    expect(within(versions).getAllByRole("button")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("From"), "s1");
    await userEvent.selectOptions(screen.getByLabelText("To"), "s2");
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Which columns? Answer: All")).toBeTruthy();
    expect(within(table).getByText("removed")).toBeTruthy();
    await userEvent.click(screen.getByText("Rendered Markdown"));
    expect(await screen.findByText("# CSV export for reports")).toBeTruthy();
  });
});
