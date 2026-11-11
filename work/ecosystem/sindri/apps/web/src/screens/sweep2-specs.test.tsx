import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import type { SpecDiff } from "../api/types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { meta, spec } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { DiffView, latestPerLineage, SpecsScreen } from "./SpecsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <SpecsScreen />
  </>
);
const noQuestions = { ...spec().body, openQuestions: [] };
const v1 = spec({ body: noQuestions });
const v2 = spec({ id: "s2", version: 2, createdAt: "2026-01-02T00:00:00Z", body: noQuestions });
const lineage = [v1, v2].map((s) => ({
  id: s.id,
  version: s.version,
  status: s.status,
  title: s.title,
  createdAt: s.createdAt,
}));
const emptyDiff: SpecDiff = {
  from: "s1",
  to: "s2",
  changed: true,
  goals: { added: [], removed: [] },
  nonGoals: { added: [], removed: [] },
  constraints: { added: [], removed: [] },
  risks: { added: [], removed: [] },
  assumptions: { added: [], removed: [], changed: [] },
  acceptanceCriteria: { added: [], removed: [], changed: [] },
  openQuestions: { added: [], removed: [], changed: [] },
};

describe("latestPerLineage", { timeout: 20_000 }, () => {
  it("keeps the highest version of each lineage, newest lineage first", () => {
    const other = spec({ id: "o1", lineageId: "L2", createdAt: "2026-02-01T00:00:00Z" });
    // The newer version comes first, so the older one must not replace it.
    expect(latestPerLineage([v2, v1, other]).map((s) => [s.id, s.versions])).toEqual([
      ["o1", 1],
      ["s2", 2],
    ]);
  });
});

describe("DiffView", { timeout: 20_000 }, () => {
  it("says when nothing changed", () => {
    render(<DiffView diff={{ ...emptyDiff, changed: false }} />);
    expect(screen.getByText("No differences.")).toBeTruthy();
  });

  it("shows title, problem and changed items", () => {
    render(
      <DiffView
        diff={{
          ...emptyDiff,
          title: { from: "Old", to: "New" },
          problem: { from: "P1", to: "P2" },
          acceptanceCriteria: {
            added: [],
            removed: [],
            changed: [{ id: "AC1", text: "Exists" }],
          },
        }}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "titlechangedOld → New",
      "problemchangedP1 → P2",
      'acceptanceCriteriachanged{"id":"AC1","text":"Exists"}',
    ]);
  });
});

describe("SpecsScreen (sweep 2)", { timeout: 20_000 }, () => {
  it("asks for a project when none is selected", () => {
    const api = mockApi();
    renderWithStore(ui, api, { projectId: null });
    expect(screen.getByText("Create or select a project first.")).toBeTruthy();
    expect(api.listSpecs).not.toHaveBeenCalled();
  });

  it("opens a spec from the list and another version from the version list", async () => {
    const api = mockApi({
      listSpecs: [v1, v2],
      getSpec: (id: string) =>
        Promise.resolve({ spec: id === "s1" ? v1 : v2, meta: meta(), lineage }),
    });
    renderWithStore(ui, api);
    expect(screen.getByText(/Select a spec to see its versions/)).toBeTruthy();
    const item = await screen.findByRole("button", { name: /CSV export for reports\s*v2/ });
    expect(item.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(item);
    expect(api.getSpec).toHaveBeenCalledWith("s2");
    expect(item.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(await screen.findByRole("button", { name: "v1 (draft)" }));
    expect(api.getSpec).toHaveBeenLastCalledWith("s1");
    expect(
      await screen.findByText(
        "This is not the latest version; only v2 can be submitted or approved.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit for review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("reports a failed submission and keeps the button usable", async () => {
    const api = mockApi({
      listSpecs: [v1],
      getSpec: { spec: v1, meta: meta(), lineage: lineage.slice(0, 1) },
      submitSpec: () => Promise.reject(new Error("spec changed meanwhile")),
    });
    renderWithStore(ui, api, { specId: "s1" });
    await userEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/spec changed meanwhile/);
    expect(screen.getByRole("button", { name: "Submit for review" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("counts several blocking questions", async () => {
    const review = spec({
      status: "review",
      body: {
        ...spec().body,
        openQuestions: [
          { id: "Q1", text: "Which columns?", blocking: true },
          { id: "Q3", text: "Encoding?", blocking: true },
        ],
      },
    });
    renderWithStore(
      ui,
      mockApi({
        listSpecs: [review],
        getSpec: { spec: review, meta: meta(), lineage: lineage.slice(0, 1) },
      }),
      { specId: "s1" },
    );
    expect(
      await screen.findByText(/Approval is blocked: 2 blocking open questions \(Q1, Q3\)/),
    ).toBeTruthy();
  });

  it("offers nothing to do with a superseded version", async () => {
    const old = spec({ status: "superseded", body: noQuestions });
    renderWithStore(
      ui,
      mockApi({
        listSpecs: [old],
        getSpec: { spec: old, meta: meta(), lineage: [{ ...lineage[0]!, status: "superseded" }] },
      }),
      { specId: "s1" },
    );
    expect(await screen.findByText("This version is superseded.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Propose plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("edits the problem, and Cancel closes the form without saving", async () => {
    const api = mockApi({
      listSpecs: [v1],
      getSpec: { spec: v1, meta: meta(), lineage: lineage.slice(0, 1) },
    });
    renderWithStore(ui, api, { specId: "s1" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit specification" });
    const problem = within(form).getByLabelText("Problem");
    await userEvent.clear(problem);
    const save = within(form).getByRole("button", { name: /^Save as new version/ });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.textContent).toMatch(/Describe the problem/);
    await userEvent.type(problem, "New problem");
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit specification" })).toBeNull();
    expect(api.reviseSpec).not.toHaveBeenCalled();
  });

  it("signs out when rendering the Markdown is refused as unauthenticated", async () => {
    const api = mockApi({
      listSpecs: [v1],
      getSpec: { spec: v1, meta: meta(), lineage: lineage.slice(0, 1) },
      renderSpec: () => Promise.reject(new ApiError(401, "unauthorized", "token rejected")),
    });
    const { container } = renderWithStore(
      <>
        {ui}
        <SignedIn />
      </>,
      api,
      { specId: "s1" },
    );
    await userEvent.click(await screen.findByText("Rendered Markdown"));
    expect(await screen.findByText(/Could not render the spec: token rejected/)).toBeTruthy();
    expect(within(container).getByTestId("token").textContent).toBe("signed out");
  });

  it("shows a non-Error rendering failure and does not reload once loaded", async () => {
    const api = mockApi({
      listSpecs: [v1],
      getSpec: { spec: v1, meta: meta(), lineage: lineage.slice(0, 1) },
    });
    api.renderSpec.mockRejectedValueOnce("plain failure").mockResolvedValue("# Done");
    renderWithStore(ui, api, { specId: "s1" });
    const summary = await screen.findByText("Rendered Markdown");
    await userEvent.click(summary);
    expect(await screen.findByText("Could not render the spec: plain failure")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("# Done")).toBeTruthy();
    // Closing and opening again keeps what was rendered.
    await userEvent.click(summary);
    await userEvent.click(summary);
    expect(api.renderSpec).toHaveBeenCalledTimes(2);
  });
});

function SignedIn() {
  const { state } = useStore();
  return <output data-testid="token">{state.token ? "signed in" : "signed out"}</output>;
}
