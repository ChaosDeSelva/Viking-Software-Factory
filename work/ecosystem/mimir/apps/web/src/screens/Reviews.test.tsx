import { newId } from "@mimir/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { approval, event, mission, snapshot, task } from "../test/fixtures.js";
import { accepted, mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Reviews } from "./Reviews.js";

function setup() {
  const m = mission({ objective: "Mission R" });
  const t = task({ missionId: m.id, title: "Cleanup", status: "blocked" });
  const pending = approval({
    action: "shell.destructive",
    reason: "rm -rf dist",
    missionId: m.id,
    taskId: t.id,
  });
  const decided = approval({ action: "pr.create", status: "approved", actor: "operator" });
  const history = [
    event(
      "test.run_completed",
      { command: "pnpm test", passed: false, total: 4, failed: 1 },
      { missionId: m.id, taskId: t.id },
    ),
    event(
      "artifact.recorded",
      { artifactId: newId("art"), taskId: t.id, kind: "diff", uri: "file:///d", hash: "h" },
      { missionId: m.id, taskId: t.id },
    ),
    event(
      "policy.denied",
      { action: "git.push", reason: "push requires approval" },
      { missionId: m.id, taskId: t.id },
    ),
  ];
  const client = mockClient({
    snapshot: vi.fn(async () =>
      snapshot({ missions: [m], tasks: [t], approvals: [pending, decided] }),
    ),
  });
  vi.mocked(client.events.list).mockResolvedValue(page(history, null));
  return { m, t, pending, decided, client };
}

describe("Reviews", () => {
  it("lists pending approvals with context and is accessible", async () => {
    const { pending, client } = setup();
    const { container } = renderWithStore(<Reviews />, { client });
    const inbox = await screen.findByRole("region", { name: "Pending approvals" });
    expect(within(inbox).getByText("shell.destructive")).toBeTruthy();
    expect(within(inbox).getByText("rm -rf dist")).toBeTruthy();
    expect(within(inbox).getByRole("link", { name: "Cleanup" })).toBeTruthy();
    expect(within(inbox).getByRole("button", { name: `Approve ${pending.id}` })).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("approves and shows the audit result", async () => {
    const user = userEvent.setup();
    const { pending, client } = setup();
    renderWithStore(<Reviews />, { client });
    await user.click(await screen.findByRole("button", { name: `Approve ${pending.id}` }));
    expect(client.approvals.decide).toHaveBeenCalledWith(pending.id, { decision: "approved" });
    const status = await screen.findByText(/Approved/);
    expect(status.textContent).toMatch(/operation op_/);
  });

  it("keeps the audit result after approval.decided removes the card (decided before the POST resolves)", async () => {
    const user = userEvent.setup();
    const { pending, client } = setup();
    let resolveDecide: ((v: Awaited<ReturnType<typeof client.approvals.decide>>) => void) | null =
      null;
    vi.mocked(client.approvals.decide).mockImplementationOnce(
      () => new Promise((r) => (resolveDecide = r)),
    );
    renderWithStore(<Reviews />, { client });
    await user.click(await screen.findByRole("button", { name: `Approve ${pending.id}` }));
    act(() =>
      client.streamController.push(
        event("approval.decided", {
          approvalId: pending.id,
          decision: "approved",
          actor: "operator",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `Approve ${pending.id}` })).toBeNull(),
    );
    await act(async () => resolveDecide?.(accepted()));
    const decisions = screen.getByRole("region", { name: "Recent decisions" });
    await waitFor(() =>
      expect(within(decisions).getByText(new RegExp(`Approved ${pending.id}`)).textContent).toMatch(
        /operation op_/,
      ),
    );
  });

  it("rejecting requires a reason", async () => {
    const user = userEvent.setup();
    const { pending, client } = setup();
    renderWithStore(<Reviews />, { client });
    await user.click(await screen.findByRole("button", { name: `Reject ${pending.id}` }));
    expect(client.approvals.decide).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/reason/i);
    const input = screen.getByRole("textbox", { name: new RegExp(`^Reason.*${pending.id}$`) });
    expect(input.getAttribute("aria-label")).toBeNull();
    await user.type(input, "too risky");
    await user.click(screen.getByRole("button", { name: `Reject ${pending.id}` }));
    expect(client.approvals.decide).toHaveBeenCalledWith(pending.id, {
      decision: "rejected",
      reason: "too risky",
    });
  });

  it("shows server errors from a decision", async () => {
    const user = userEvent.setup();
    const { pending, client } = setup();
    vi.mocked(client.approvals.decide).mockRejectedValueOnce(
      Object.assign(new Error("approval expired"), {
        name: "MimirError",
        code: "invalid_transition",
      }),
    );
    renderWithStore(<Reviews />, { client });
    await user.click(await screen.findByRole("button", { name: `Approve ${pending.id}` }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid_transition/);
  });

  it("shows failing tests, diffs, high-risk commands and recent decisions", async () => {
    const { client } = setup();
    renderWithStore(<Reviews />, { client });
    const tests = await screen.findByRole("region", { name: "Test results" });
    await waitFor(() => expect(within(tests).getByText("pnpm test")).toBeTruthy());
    expect(within(tests).getByText(/1 of 4 failed/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Diffs" })).getByText("diff")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "High-risk commands" })).getByText(/git.push/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Recent decisions" })).getByText("pr.create"),
    ).toBeTruthy();
  });

  it("a 401 from a decision re-prompts for the token", async () => {
    const user = userEvent.setup();
    const { pending, client } = setup();
    const onUnauthorized = vi.fn();
    vi.mocked(client.approvals.decide).mockRejectedValueOnce(
      Object.assign(new Error("bad token"), { name: "MimirError", code: "unauthorized" }),
    );
    renderWithStore(<Reviews />, { client, onUnauthorized });
    await user.click(await screen.findByRole("button", { name: `Approve ${pending.id}` }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it("shows empty inbox", async () => {
    renderWithStore(<Reviews />, { client: mockClient() });
    expect(await screen.findByText(/No pending approvals/)).toBeTruthy();
  });
});
