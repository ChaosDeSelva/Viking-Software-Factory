import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { Decision } from "../api/steward-types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { decision, note, stewardStatus, stewardType } from "../test/steward-fixtures.js";
import { mockApi, PROJECT, renderWithStore, type MockApi } from "../test/utils.js";
import { AutonomyScreen, POLL_MS } from "./AutonomyScreen.js";

function Probe() {
  const { state } = useStore();
  return (
    <p data-testid="probe">
      {state.view}|{state.projectId}|{state.specId ?? ""}|{state.executionId ?? ""}
    </p>
  );
}

const ui = (
  <>
    <NoticeRegion />
    <AutonomyScreen />
    <Probe />
  </>
);

/** An API with a running steward, one pending decision and one note unless overridden. */
function api(over: Parameters<typeof mockApi>[0] = {}): MockApi {
  return mockApi({
    stewardStatus: stewardStatus(),
    listDecisions: [decision()],
    listStewardNotes: [note(), note({ id: "n2", projectId: null, text: "Never touch prod" })],
    ...over,
  });
}

const log = () => screen.findByRole("list", { name: "Decisions" });
const entry = async (name: RegExp | string) => {
  const items = within(await log()).getAllByRole("listitem");
  const found = items.find((li) => within(li).queryByText(name));
  if (!found) throw new Error(`no entry ${String(name)}`);
  return found;
};
const expand = async (name: RegExp | string) => {
  const li = await entry(name);
  await userEvent.click(within(li).getByRole("button", { name: /^Details/ }));
  return li;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AutonomyScreen: steward status and modes", () => {
  it("shows running state and pauses, then resumes", async () => {
    const a = api({
      pauseSteward: stewardStatus({ running: false }),
      resumeSteward: stewardStatus({ running: true }),
    });
    renderWithStore(ui, a);
    const bar = await screen.findByLabelText("Steward status");
    expect(within(bar).getByText("Running")).toBeTruthy();
    expect(within(bar).getByText("Connected to http://127.0.0.1:8787")).toBeTruthy();
    await userEvent.click(within(bar).getByRole("button", { name: "Pause" }));
    expect(a.pauseSteward).toHaveBeenCalledOnce();
    expect(await within(bar).findByText("Paused")).toBeTruthy();
    await userEvent.click(within(bar).getByRole("button", { name: "Resume" }));
    expect(a.resumeSteward).toHaveBeenCalledOnce();
    expect(await within(bar).findByText("Running")).toBeTruthy();
  });

  it("shows Feedback Graph as unreachable or not configured", async () => {
    const s = stewardStatus();
    renderWithStore(
      ui,
      api({
        stewardStatus: {
          ...s,
          feedbackGraph: { ...s.feedbackGraph, reachable: false, error: "connection refused" },
        },
      }),
    );
    expect(await screen.findByText("Unreachable: connection refused")).toBeTruthy();
  });

  it("says when Feedback Graph is not configured", async () => {
    const s = stewardStatus();
    renderWithStore(
      ui,
      api({
        stewardStatus: {
          ...s,
          feedbackGraph: {
            configured: false,
            enabled: false,
            url: null,
            reachable: null,
            error: null,
          },
        },
      }),
    );
    expect(await screen.findByText("Not configured (set it up in Settings)")).toBeTruthy();
  });

  it("shows each type's track record and disables auto where it is not allowed", async () => {
    renderWithStore(ui, api());
    const answer = (
      await screen.findByRole("rowheader", { name: "Answer spec questions" })
    ).closest("tr")!;
    expect(
      within(answer)
        .getAllByRole("cell")
        .slice(1)
        .map((c) => c.textContent),
    ).toEqual(["6", "2", "1", "1", "0", "80%"]);
    const approve = screen.getByRole("rowheader", { name: "Approve plans" }).closest("tr")!;
    expect(within(approve).getAllByRole("cell").at(-1)!.textContent).toBe("—");
    const select = within(approve).getByLabelText("Mode for Approve plans");
    const auto = within(select).getByRole("option", { name: "Auto" }) as HTMLOptionElement;
    expect(auto.disabled).toBe(true);
    expect(select.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(approve).getByText(/Auto is not available: this is an approval/)).toBeTruthy();
    const answerAuto = within(
      within(answer).getByLabelText("Mode for Answer spec questions"),
    ).getByRole("option", { name: "Auto" }) as HTMLOptionElement;
    expect(answerAuto.disabled).toBe(false);
  });

  it("changes a mode and shows the types the server returns", async () => {
    const a = api({
      setStewardMode: [
        stewardType({ mode: "auto" }),
        stewardType({ type: "plan.approve", autoAllowed: false }),
      ],
    });
    renderWithStore(ui, a);
    const select = (await screen.findByLabelText(
      "Mode for Answer spec questions",
    )) as HTMLSelectElement;
    await userEvent.selectOptions(select, "auto");
    expect(a.setStewardMode).toHaveBeenCalledWith("spec.answer", "auto");
    await waitFor(() => expect(select.value).toBe("auto"));
  });

  it("gates mode changes behind the approval pairing code", async () => {
    let unlocked = false;
    const a = api({
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "p", expiresAt: "" });
      },
      setStewardMode: [stewardType({ mode: "off" })],
    });
    renderWithStore(ui, a);
    const select = (await screen.findByLabelText(
      "Mode for Answer spec questions",
    )) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    const code = document.getElementById("steward-mode-approval")!;
    await userEvent.type(code, "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(a.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "off");
    expect(a.setStewardMode).toHaveBeenCalledWith("spec.answer", "off");
  });

  it("reports a refused mode change", async () => {
    const a = api({
      setStewardMode: () =>
        Promise.reject(new ApiError(422, "validation_error", "auto is not allowed for this type")),
    });
    renderWithStore(ui, a);
    await userEvent.selectOptions(
      await screen.findByLabelText("Mode for Answer spec questions"),
      "auto",
    );
    expect((await screen.findByText(/auto is not allowed/)).closest('[role="alert"]')).toBeTruthy();
    expect(
      (screen.getByLabelText("Mode for Answer spec questions") as HTMLSelectElement).value,
    ).toBe("recommend");
  });
});

describe("AutonomyScreen: decision log", () => {
  it("lists the project's decisions with their key facts", async () => {
    const a = api({
      listDecisions: [
        decision({
          id: "d2",
          subject: { kind: "plan", id: "pl1", label: "Plan v2" },
          type: "plan.approve",
        }),
        decision({
          status: "applied",
          mode: "auto",
          outcome: { result: "passed", detail: "checks green" },
        }),
      ],
    });
    renderWithStore(ui, a);
    const items = within(await log()).getAllByRole("listitem");
    expect(a.listDecisions).toHaveBeenCalledWith({ projectId: "p1", limit: 50 });
    // Server order (newest first) is kept.
    expect(items[0]!.textContent).toContain("Plan v2");
    expect(items[0]!.textContent).toContain("Approve plans");
    expect(items[0]!.textContent).toContain("Pending");
    const second = items[1]!;
    expect(second.textContent).toContain("CSV export: which columns?");
    expect(second.textContent).toContain("Recommendation: All visible columns");
    expect(second.textContent).toContain("Confidence 82%");
    expect(second.textContent).toContain("Mode Auto");
    expect(second.textContent).toContain("Applied");
    expect(second.textContent).toContain("Outcome Passed (checks green)");
  });

  it("filters by type, status and project", async () => {
    const a = api();
    renderWithStore(ui, a);
    await log();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "escalation.resolve");
    await waitFor(() =>
      expect(a.listDecisions).toHaveBeenLastCalledWith({
        projectId: "p1",
        type: "escalation.resolve",
        limit: 50,
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText("Status"), "rolled_back");
    await waitFor(() =>
      expect(a.listDecisions).toHaveBeenLastCalledWith({
        projectId: "p1",
        type: "escalation.resolve",
        status: "rolled_back",
        limit: 50,
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText("Show"), "all");
    await waitFor(() =>
      expect(a.listDecisions).toHaveBeenLastCalledWith({
        type: "escalation.resolve",
        status: "rolled_back",
        limit: 50,
      }),
    );
    expect(a.listStewardNotes).toHaveBeenLastCalledWith(null);
  });

  it("shows an empty state and a load error with retry", async () => {
    let fail = true;
    const a = api({
      listDecisions: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve([])),
    });
    renderWithStore(ui, a);
    expect(await screen.findByText("Could not load decisions: boom")).toBeTruthy();
    fail = false;
    const alert = screen.getByText("Could not load decisions: boom").closest('[role="alert"]')!;
    await userEvent.click(within(alert as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No decisions match.")).toBeTruthy();
  });

  it("expands to reasoning and inputs and links to the subject and inputs", async () => {
    renderWithStore(ui, api());
    const li = await expand("CSV export: which columns?");
    expect(within(li).getByText("The reports table shows these columns.")).toBeTruthy();
    expect(within(li).getByText("Matches the reports table")).toBeTruthy();
    const inputs = within(li).getByRole("list", { name: "Inputs considered" });
    expect(inputs.textContent).toContain("Lesson");
    expect(inputs.textContent).toContain("fg:L7");
    expect(inputs.textContent).toContain("Past decision");
    expect(inputs.textContent).toContain("Answered with all columns; accepted");
    await userEvent.click(within(inputs).getByRole("button", { name: "e1" }));
    expect(screen.getByTestId("probe").textContent).toBe("runs|p1||e1");
  });

  it("opens the subject, switching to its project when it is another one", async () => {
    renderWithStore(ui, api({ listDecisions: [decision({ projectId: "p2" })] }), {
      projects: [PROJECT, { id: "p2", name: "Other", repoPath: "/r/o" }],
    });
    const li = await entry("CSV export: which columns?");
    await userEvent.click(within(li).getByRole("button", { name: "CSV export: which columns?" }));
    expect(screen.getByTestId("probe").textContent).toBe("specs|p2|s1|");
  });

  it("accepts a recommendation as it is", async () => {
    const a = api({ acceptDecision: decision({ status: "accepted" }) });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    await userEvent.click(within(li).getByRole("button", { name: "Accept" }));
    expect(a.acceptDecision).toHaveBeenCalledWith({ id: "d1", type: "spec.answer" }, undefined);
    expect(await within(li).findByText("Accepted")).toBeTruthy();
    expect(within(li).queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("accepts an edited answer as a changed decision", async () => {
    const a = api({ acceptDecision: decision({ status: "changed" }) });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    const answer = within(li).getByLabelText("Answer");
    expect((answer as HTMLTextAreaElement).value).toBe("All visible columns");
    await userEvent.clear(answer);
    await userEvent.type(answer, "Only id and total");
    await userEvent.click(within(li).getByRole("button", { name: "Accept changed answer" }));
    expect(a.acceptDecision).toHaveBeenCalledWith(
      { id: "d1", type: "spec.answer" },
      "Only id and total",
    );
    expect(await within(li).findByText("Changed")).toBeTruthy();
  });

  it("rejects with an optional reason", async () => {
    const a = api({ rejectDecision: decision({ status: "rejected" }) });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    await userEvent.type(within(li).getByLabelText("Reason for rejecting (optional)"), "too broad");
    await userEvent.click(within(li).getByRole("button", { name: "Reject" }));
    expect(a.rejectDecision).toHaveBeenCalledWith("d1", "too broad");
    expect(await within(li).findByText("Rejected")).toBeTruthy();
  });

  it("rejects without a reason", async () => {
    const a = api({ rejectDecision: decision({ status: "rejected" }) });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    await userEvent.click(within(li).getByRole("button", { name: "Reject" }));
    expect(a.rejectDecision).toHaveBeenCalledWith("d1", undefined);
  });

  it("rolls back an applied reversible decision only with a reason", async () => {
    const a = api({
      listDecisions: [decision({ status: "applied", mode: "auto" })],
      rollbackDecision: decision({ status: "rolled_back" }),
    });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    expect(within(li).queryByRole("button", { name: "Accept" })).toBeNull();
    const button = within(li).getByRole("button", { name: "Roll back" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(within(li).getByLabelText("Reason for rolling back"), "wrong answer");
    await userEvent.click(button);
    expect(a.rollbackDecision).toHaveBeenCalledWith("d1", "wrong answer");
    expect(await within(li).findByText("Rolled back")).toBeTruthy();
    expect(within(li).queryByRole("button", { name: "Roll back" })).toBeNull();
  });

  it("offers no roll back for an irreversible or pending decision", async () => {
    renderWithStore(
      ui,
      api({
        listDecisions: [
          decision({
            id: "a",
            status: "applied",
            reversible: false,
            subject: { kind: "spec", id: "s1", label: "One" },
          }),
          decision({ id: "b", subject: { kind: "spec", id: "s2", label: "Two" } }),
        ],
      }),
    );
    for (const name of ["One", "Two"]) {
      const li = await expand(name);
      expect(within(li).queryByRole("button", { name: "Roll back" })).toBeNull();
    }
  });

  it("reports a refused roll back and keeps the reason", async () => {
    const a = api({
      listDecisions: [decision({ status: "accepted" })],
      rollbackDecision: () => Promise.reject(new ApiError(409, "conflict", "not reversible")),
    });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    await userEvent.type(within(li).getByLabelText("Reason for rolling back"), "oops");
    await userEvent.click(within(li).getByRole("button", { name: "Roll back" }));
    expect(await screen.findByText(/not reversible/)).toBeTruthy();
    expect((within(li).getByLabelText("Reason for rolling back") as HTMLInputElement).value).toBe(
      "oops",
    );
  });

  it("adds a note to a decision", async () => {
    const a = api({
      addDecisionNote: decision({
        notes: [note({ id: "n9", decisionId: "d1", text: "check totals" })],
      }),
    });
    renderWithStore(ui, a);
    const li = await expand("CSV export: which columns?");
    await userEvent.type(within(li).getByLabelText("Note on this decision"), "check totals");
    await userEvent.click(within(li).getByRole("button", { name: "Add note" }));
    expect(a.addDecisionNote).toHaveBeenCalledWith("d1", "check totals");
    const notes = await within(li).findByRole("list", { name: "Decision notes" });
    expect(notes.textContent).toContain("operator: check totals");
    expect((within(li).getByLabelText("Note on this decision") as HTMLInputElement).value).toBe("");
  });

  it("gates accepting an approval-type recommendation behind the pairing code", async () => {
    let unlocked = false;
    const approve = decision({
      id: "d5",
      type: "plan.approve",
      subject: { kind: "plan", id: "pl1", label: "Plan v2" },
      recommendation: { value: "approve" },
    });
    const a = api({
      listDecisions: [approve],
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "p", expiresAt: "" });
      },
      acceptDecision: { ...approve, status: "accepted" } satisfies Decision,
    });
    renderWithStore(ui, a);
    const li = await expand("Plan v2");
    // No answer to edit for an approval.
    expect(within(li).queryByLabelText("Answer")).toBeNull();
    const accept = within(li).getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    await userEvent.type(within(li).getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(within(li).getByRole("button", { name: "Unlock approvals" }));
    await waitFor(() => expect(accept.disabled).toBe(false));
    await userEvent.click(accept);
    expect(a.acceptDecision).toHaveBeenCalledWith({ id: "d5", type: "plan.approve" }, undefined);
  });

  it("renders unknown enum values raw without crashing", async () => {
    renderWithStore(
      ui,
      api({
        stewardStatus: stewardStatus({
          types: [stewardType({ type: "delivery.export", mode: "turbo", autoAllowed: false })],
        }),
        listDecisions: [
          decision({
            type: "delivery.export",
            status: "snoozed",
            mode: "hybrid",
            subject: { kind: "ticket", id: "T-1", label: "Ticket T-1" },
            inputs: [{ kind: "vibes", ref: "x1", summary: "a hunch" }],
            outcome: { result: "meh" },
          }),
        ],
      }),
    );
    const row = (await screen.findByRole("rowheader", { name: "delivery.export" })).closest("tr")!;
    expect(
      (within(row).getByLabelText("Mode for delivery.export") as HTMLSelectElement).value,
    ).toBe("turbo");
    const li = await expand("Ticket T-1");
    expect(li.textContent).toContain("delivery.export");
    expect(li.textContent).toContain("snoozed");
    expect(li.textContent).toContain("Mode hybrid");
    expect(li.textContent).toContain("Outcome meh");
    // An unknown subject kind is not a link; an unknown input kind shows raw.
    expect(within(li).queryByRole("button", { name: "Ticket T-1" })).toBeNull();
    expect(within(li).getByRole("list", { name: "Inputs considered" }).textContent).toContain(
      "vibes",
    );
    // Unknown status: neither accept nor roll back is offered.
    expect(within(li).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(within(li).queryByRole("button", { name: "Roll back" })).toBeNull();
  });
});

describe("AutonomyScreen: polling", () => {
  const setVisibility = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => setVisibility("visible"));

  it("refreshes while visible, pauses while hidden and stops on unmount", async () => {
    vi.useFakeTimers();
    const a = api();
    const view = renderWithStore(ui, a);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(3);

    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(3);

    // Becoming visible refreshes at once, then resumes the interval.
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(5);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(5);
  });

  it("never overlaps requests and keeps the list when a refresh fails", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    let calls = 0;
    const a = api({
      listDecisions: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([decision()]);
        if (calls === 2)
          return new Promise<Decision[]>((_, reject) => {
            release = () => reject(new Error("server busy"));
          });
        return Promise.resolve([decision()]);
      },
    });
    renderWithStore(ui, a);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(calls).toBe(2);
    // Still waiting on the second request: no new one starts.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(calls).toBe(2);
    await act(async () => {
      release!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Could not refresh: server busy")).toBeTruthy();
    expect(screen.getByText("CSV export: which columns?")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(calls).toBe(3);
    expect(screen.queryByText(/Could not refresh/)).toBeNull();
  });

  it("keeps a typed answer across refreshes", async () => {
    vi.useFakeTimers();
    const a = api();
    renderWithStore(ui, a);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const li = screen.getByText("CSV export: which columns?").closest("li")!;
    fireEvent.click(within(li).getByRole("button", { name: /^Details/ }));
    fireEvent.change(within(li).getByLabelText("Answer"), { target: { value: "Edited" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(a.listDecisions).toHaveBeenCalledTimes(3);
    expect((within(li).getByLabelText("Answer") as HTMLTextAreaElement).value).toBe("Edited");
  });
});

describe("AutonomyScreen: notes feed", () => {
  it("shows project and global notes", async () => {
    const a = api();
    renderWithStore(ui, a);
    const notes = await screen.findByRole("list", { name: "Notes" });
    expect(a.listStewardNotes).toHaveBeenCalledWith("p1");
    const items = within(notes).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Project");
    expect(items[0]!.textContent).toContain("Prefer small PRs");
    expect(items[1]!.textContent).toContain("Global");
    expect(items[1]!.textContent).toContain("Never touch prod");
  });

  it("adds a project note and a global note", async () => {
    const a = api({
      addStewardNote: (projectId: string | null, text: string) =>
        Promise.resolve(note({ id: `new-${text}`, projectId, text })),
    });
    renderWithStore(ui, a);
    const form = await screen.findByRole("form", { name: "Add a note for the steward" });
    await userEvent.type(within(form).getByLabelText("New note"), "Run lint first");
    await userEvent.click(within(form).getByRole("button", { name: "Add note" }));
    expect(a.addStewardNote).toHaveBeenCalledWith("p1", "Run lint first");
    const notes = await screen.findByRole("list", { name: "Notes" });
    await waitFor(() =>
      expect(within(notes).getAllByRole("listitem")[0]!.textContent).toContain("Run lint first"),
    );
    expect((within(form).getByLabelText("New note") as HTMLTextAreaElement).value).toBe("");

    await userEvent.selectOptions(within(form).getByLabelText("Applies to"), "global");
    await userEvent.type(within(form).getByLabelText("New note"), "No Friday deploys");
    await userEvent.click(within(form).getByRole("button", { name: "Add note" }));
    expect(a.addStewardNote).toHaveBeenLastCalledWith(null, "No Friday deploys");
    await waitFor(() =>
      expect(within(notes).getAllByRole("listitem")[0]!.textContent).toContain("Global"),
    );
  });

  it("shows an empty feed", async () => {
    renderWithStore(ui, api({ listStewardNotes: [] }));
    expect(await screen.findByText("No notes yet.")).toBeTruthy();
  });
});
