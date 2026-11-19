import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JournalEntry, JournalProposal } from "../api/steward-types.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ProjectDecisionJournal } from "./ProjectDecisionJournal.js";

const original: JournalEntry = {
  id: "d1",
  title: "Retry limit",
  decision: "Retry once",
  rationale: "Avoid duplicate deliveries",
  source: "Ticket 45",
  actor: "Planner",
  status: "accepted",
  createdAt: "2026-11-15T08:00:00Z",
  decidedBy: "Pat",
  decidedAt: "2026-11-16T09:00:00Z",
  supersedesId: null,
  history: [{ status: "accepted", actor: "Pat", at: "2026-11-16T09:00:00Z" }],
};
const ui = <ProjectDecisionJournal projectId="p1" />;
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Project decision journal", () => {
  it("submits a reversal as a linked proposal and changes the effective rule only on approval", async () => {
    const entries = [original];
    const a = mockApi({
      getProjectJournal: () =>
        Promise.resolve({ entries: [...entries], markdown: "## Decision log" }),
      proposeProjectDecision: (_project: string, proposal: JournalProposal) => {
        entries.push({
          ...original,
          ...proposal,
          id: "d2",
          supersedesId: proposal.supersedesId!,
          status: "proposed",
          decidedBy: null,
          decidedAt: null,
          history: [],
        });
        return Promise.resolve({});
      },
      reviewProjectDecision: () => {
        entries[0] = { ...original, status: "superseded" };
        entries[1] = { ...entries[1]!, status: "accepted" };
        return Promise.resolve({});
      },
    });
    renderWithStore(ui, a);
    await userEvent.click(await screen.findByRole("button", { name: "Propose reversal" }));
    expect(screen.getByText(/stays in effect/)).toBeTruthy();
    fill("What should apply after the reversal?", "Stop after the first attempt");
    fill("Why make this choice?", "The receiver cannot deduplicate");
    fill("Source", "Incident 47");
    await userEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    expect(a.proposeProjectDecision).toHaveBeenCalledWith("p1", {
      title: "Retry limit",
      decision: "Stop after the first attempt",
      rationale: "The receiver cannot deduplicate",
      source: "Incident 47",
      supersedesId: "d1",
    });
    expect(await screen.findByText("Awaiting approval")).toBeTruthy();
    expect(screen.getByText("In effect")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(a.reviewProjectDecision).toHaveBeenCalledWith("p1", "d2", "accepted");
    expect(await screen.findByText("Replaced")).toBeTruthy();
    expect(screen.getByText(/Replaced by/)).toBeTruthy();
    expect(screen.getByText("Decision history")).toBeTruthy();
    expect(screen.getByText(/Reviewed by Pat/)).toBeTruthy();
  });

  it("explains how to replace an accepted choice that is private to the journal", async () => {
    const a = mockApi({
      getProjectJournal: {
        entries: [
          { ...original, exportBlockedReason: "The statement contains a private reference." },
        ],
        markdown: "",
      },
    });
    renderWithStore(ui, a);
    expect(await screen.findByText("Private journal only.")).toBeTruthy();
    expect(screen.getByText(/Propose a replacement with project-facing wording/)).toBeTruthy();
  });

  it("lets reviewers reject a proposal after unlocking; a failed review keeps it available", async () => {
    let unlocked = false;
    const a = mockApi({
      getProjectJournal: {
        entries: [{ ...original, status: "proposed", decidedBy: null, decidedAt: null }],
        markdown: "",
      },
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({});
      },
      reviewProjectDecision: () => Promise.reject(new Error("Review failed")),
    });
    renderWithStore(ui, a);
    expect(
      ((await screen.findByRole("button", { name: "Reject proposal" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fill("Approval pairing code", "abcde");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject proposal" }));
    await waitFor(() =>
      expect(a.reviewProjectDecision).toHaveBeenCalledWith("p1", "d1", "rejected"),
    );
    expect(screen.getByText("Awaiting approval")).toBeTruthy();
    expect(screen.queryByText("In effect", { selector: "p" })).toBeNull();
  });

  it("accepts a new proposal and downloads the server's Markdown", async () => {
    const a = mockApi({
      getProjectJournal: { entries: [original], markdown: "# Server export" },
      proposeProjectDecision: {},
    });
    renderWithStore(ui, a);
    const download = await screen.findByRole("button", { name: "Download journal" });
    const make = vi.fn(() => "blob:test");
    Object.assign(URL, { createObjectURL: make, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await userEvent.click(download);
      expect(make).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
    }
    await userEvent.click(screen.getByRole("button", { name: "Propose a decision" }));
    const form = screen.getByRole("form", { name: "Decision proposal" });
    fill("Title", "Read only");
    fill("What should the project do?", "Use read-only access");
    fill("Why make this choice?", "Reports only read state");
    fill("Source", "Ticket 19");
    await userEvent.click(within(form).getByRole("button", { name: "Submit proposal" }));
    await waitFor(() =>
      expect(a.proposeProjectDecision).toHaveBeenCalledWith("p1", {
        title: "Read only",
        decision: "Use read-only access",
        rationale: "Reports only read state",
        source: "Ticket 19",
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Propose change" }));
    expect(
      (screen.getByLabelText("What should the project do?") as HTMLTextAreaElement).value,
    ).toBe(original.decision);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Decision proposal" })).toBeNull();
  });
});
