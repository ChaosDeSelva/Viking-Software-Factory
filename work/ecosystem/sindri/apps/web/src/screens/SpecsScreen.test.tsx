import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { plan, versionOf } from "../test/delivery-fixtures.js";
import { useStore } from "../store/context.js";
import { meta, spec } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { latestPerLineage, SpecsScreen } from "./SpecsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <SpecsScreen />
  </>
);
/** Where the store says the app is, so a test can assert navigation. */
function Where() {
  const { state } = useStore();
  return <output data-testid="where">{`${state.view}:${state.planId ?? ""}`}</output>;
}
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

  it("answers a non-blocking question and keeps text typed for other questions (M2, M3)", async () => {
    const first = spec();
    const second = spec({
      id: "s2",
      version: 2,
      body: {
        ...spec().body,
        openQuestions: [{ id: "Q2", text: "File name?", blocking: false }],
      },
    });
    const third = spec({ id: "s3", version: 3, body: { ...spec().body, openQuestions: [] } });
    const details: Record<string, unknown> = {
      s1: { spec: first, meta: meta(), lineage: lineage.slice(0, 1) },
      s2: { spec: second, meta: meta(), lineage },
      s3: { spec: third, meta: meta(), lineage },
    };
    const api = mockApi({
      listSpecs: [first],
      getSpec: (id: string) => Promise.resolve(details[id]),
      answer: (id: string) => Promise.resolve({ spec: id === "s1" ? second : third, meta: meta() }),
    });
    renderWithStore(ui, api, { specId: "s1" });
    const q2 = await screen.findByRole("form", { name: "Answer Q2" });
    expect(within(q2).getByText("non-blocking")).toBeTruthy();
    expect(
      within(screen.getByRole("form", { name: "Answer Q1" })).getByText("blocking"),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Q2: File name?"), "report.csv");
    await userEvent.type(screen.getByLabelText("Q1: Which columns?"), "All");
    await userEvent.click(screen.getByRole("button", { name: "Submit answer to Q1" }));
    expect(api.answer).toHaveBeenCalledWith("s1", "Q1", "All");
    // The answer opened v2 (a new id); what was typed for Q2 is still there.
    await screen.findByRole("button", { name: "v2 (draft)" });
    const kept = (await screen.findByLabelText("Q2: File name?")) as HTMLTextAreaElement;
    expect(kept.value).toBe("report.csv");
    expect(screen.queryByRole("form", { name: "Answer Q1" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Submit answer to Q2" }));
    expect(api.answer).toHaveBeenLastCalledWith("s2", "Q2", "report.csv");
  });

  it("proposes a plan from an approved spec and opens it (M6)", async () => {
    const approved = spec({ status: "approved", body: { ...spec().body, openQuestions: [] } });
    let finish: (v: unknown) => void = () => undefined;
    const api = mockApi({
      listSpecs: [approved],
      getSpec: { spec: approved, meta: meta(), lineage: lineage.slice(0, 1) },
      proposePlan: () => new Promise((resolve) => (finish = resolve)),
    });
    renderWithStore(
      <>
        {ui}
        <Where />
      </>,
      api,
      { specId: "s1" },
    );
    await userEvent.click(await screen.findByRole("button", { name: "Propose plan" }));
    expect(api.proposePlan).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("button", { name: "Proposing plan…" }).hasAttribute("disabled")).toBe(
      true,
    );
    const p = plan();
    finish({ plan: p, versions: [versionOf(p)], harnessSource: "fake" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("plans:pl1"));
    // Nothing to edit or answer on an approved version.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("edits a draft's title, problem and goals as a new version (M5)", async () => {
    const draft = spec();
    const revised = spec({ id: "s2", version: 2, title: "CSV and TSV export" });
    const api = mockApi({
      listSpecs: [draft],
      getSpec: (id: string) =>
        Promise.resolve(
          id === "s1"
            ? { spec: draft, meta: meta(), lineage: lineage.slice(0, 1) }
            : { spec: revised, meta: meta(), lineage },
        ),
      reviseSpec: revised,
    });
    renderWithStore(ui, api, { specId: "s1" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit specification" });
    const title = within(form).getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, " CSV and TSV export ");
    const goals = within(form).getByLabelText("Goals") as HTMLTextAreaElement;
    expect(goals.value).toBe("Export the reports page as CSV");
    await userEvent.type(goals, "{Enter}{Enter}  Export as TSV ");
    await userEvent.click(within(form).getByRole("button", { name: "Save as new version" }));
    expect(api.reviseSpec).toHaveBeenCalledWith("s1", {
      title: "CSV and TSV export",
      body: {
        problem: "Users cannot export reports as CSV.",
        goals: ["Export the reports page as CSV", "Export as TSV"],
      },
    });
    expect(await screen.findByText(/Saved your edits as v2/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "CSV and TSV export" })).toBeTruthy();
  });

  it("shows why the rendered Markdown failed and retries (L9)", async () => {
    const api = mockApi({
      listSpecs: [v1],
      getSpec: { spec: v1, meta: meta(), lineage: lineage.slice(0, 1) },
    });
    api.renderSpec.mockRejectedValueOnce(new Error("render boom")).mockResolvedValue("# Rendered");
    renderWithStore(ui, api, { specId: "s1" });
    await userEvent.click(await screen.findByText("Rendered Markdown"));
    expect(await screen.findByText(/Could not render the spec: render boom/)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("# Rendered")).toBeTruthy();
  });
});
