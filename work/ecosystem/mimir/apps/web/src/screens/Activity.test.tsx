import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { event, mission, project, snapshot } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { HISTORY_MAX_PAGES } from "../lib/useEventHistory.js";
import { Activity } from "./Activity.js";

afterEach(() => vi.restoreAllMocks());

describe("Activity", () => {
  it("shows live events and searches them", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    const { container } = renderWithStore(<Activity />, { client });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => {
      client.streamController.push(
        event("session.output", { text: "compiling widgets", redacted: false, lines: 1 }),
      );
      client.streamController.push(event("task.ready", { from: "pending", to: "ready" }));
    });
    const log = screen.getByRole("region", { name: /Event log/ });
    await waitFor(() => expect(within(log).getByText("task.ready")).toBeTruthy());
    await user.type(screen.getByLabelText("Search events"), "widgets");
    expect(within(log).queryByText("task.ready")).toBeNull();
    expect(within(log).getByText("session.output")).toBeTruthy();
    expect(screen.getByText(/1 of 2 events shown/)).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("replays from a cursor by paging the events API", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    const e1 = event("task.ready", { from: "pending", to: "ready" });
    const e2 = event("task.completed", { from: "verifying", to: "completed" });
    vi.mocked(client.events.list)
      .mockResolvedValueOnce(page([e1], "c2"))
      .mockResolvedValueOnce(page([e2], null));
    renderWithStore(<Activity />, { client });
    await user.type(await screen.findByLabelText("Replay from cursor"), "c1");
    await user.click(screen.getByRole("button", { name: "Replay" }));
    const log = screen.getByRole("region", { name: /Event log/ });
    await waitFor(() => expect(within(log).getByText("task.completed")).toBeTruthy());
    expect(client.events.list).toHaveBeenNthCalledWith(1, { cursor: "c1", limit: 500 });
    expect(client.events.list).toHaveBeenNthCalledWith(2, { cursor: "c2", limit: 500 });
    expect(screen.getByText(/Replayed 2 events/)).toBeTruthy();
  });

  it("shows cursor_expired errors", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    vi.mocked(client.events.list).mockRejectedValueOnce(
      Object.assign(new Error("cursor below retention"), {
        name: "MimirError",
        code: "cursor_expired",
      }),
    );
    renderWithStore(<Activity />, { client });
    await user.type(await screen.findByLabelText("Replay from cursor"), "old");
    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cursor_expired/);
  });

  it("exports the filtered events as JSON", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return "blob:x";
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    let revokedBeforeClickReturned = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      queueMicrotask(() => {
        revokedBeforeClickReturned = vi.mocked(URL.revokeObjectURL).mock.calls.length > 0;
      });
    });
    renderWithStore(<Activity />, { client });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    const keep = event("task.ready", { from: "pending", to: "ready" });
    act(() => {
      client.streamController.push(keep);
      client.streamController.push(
        event("session.output", { text: "noise", redacted: false, lines: 1 }),
      );
    });
    await user.click(await screen.findByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "task.ready" }));
    await user.click(screen.getByRole("button", { name: /Export JSON/ }));
    expect(click).toHaveBeenCalled();
    expect(revokedBeforeClickReturned).toBe(false);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x"));
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(await (blob as unknown as Blob).text());
    expect(parsed.map((e: { id: string }) => e.id)).toEqual([keep.id]);
  });
});

describe("Activity: project scope", () => {
  it("shows only the selected project's live events and replays per mission", async () => {
    const user = userEvent.setup();
    const p1 = project({ name: "alpha" });
    const p2 = project({ name: "beta" });
    const m1 = mission({ projectId: p1.id });
    const m2 = mission({ projectId: p2.id });
    localStorage.setItem("mimir.project", p1.id);
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ projects: [p1, p2], missions: [m1, m2] })),
    });
    const old = event(
      "task.completed",
      { from: "verifying", to: "completed" },
      { missionId: m1.id },
    );
    vi.mocked(client.events.list).mockResolvedValue(page([old], null));
    renderWithStore(<Activity />, { client });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => {
      client.streamController.push(
        event("task.ready", { from: "pending", to: "ready" }, { missionId: m1.id }),
      );
      client.streamController.push(
        event(
          "task.failed",
          { from: "running", to: "failed", reason: "x", attempt: 1, retryable: false },
          { missionId: m2.id },
        ),
      );
    });
    const log = screen.getByRole("region", { name: /Event log/ });
    await waitFor(() => expect(within(log).getByText("task.ready")).toBeTruthy());
    expect(within(log).queryByText("task.failed")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(within(log).getByText("task.completed")).toBeTruthy());
    expect(client.events.list).toHaveBeenCalledWith({ missionId: m1.id, limit: 500 });
    expect(client.events.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ missionId: m2.id }),
    );
  });

  it("continues a truncated replay per mission and never shows an unknown cursor", async () => {
    const user = userEvent.setup();
    const p1 = project({ name: "alpha" });
    const m1 = mission({ projectId: p1.id });
    const m2 = mission({ projectId: p1.id });
    localStorage.setItem("mimir.project", p1.id);
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ projects: [p1], missions: [m1, m2] })),
    });
    const ready = (missionId: typeof m1.id) =>
      event("task.ready", { from: "pending", to: "ready" }, { missionId });
    // m1 has more than one replay's worth of pages; m2 fits in one page.
    vi.mocked(client.events.list).mockImplementation(async (q) => {
      if (q?.missionId === m2.id) return page([ready(m2.id)], null);
      const n = q?.cursor ? Number(q.cursor.slice(1)) : 0;
      if (n >= HISTORY_MAX_PAGES) {
        return page(
          [event("task.completed", { from: "verifying", to: "completed" }, { missionId: m1.id })],
          null,
        );
      }
      return page([ready(m1.id)], `c${n + 1}`);
    });
    renderWithStore(<Activity />, { client });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Replay" }));
    const result = await screen.findByText(/Replayed \d+ events/);
    expect(result.textContent).toMatch(/stopped early; Continue loads the rest of 1 mission\b/);
    expect(result.textContent).not.toContain("?");
    const log = screen.getByRole("region", { name: /Event log/ });
    expect(within(log).queryByText("task.completed")).toBeNull();

    vi.mocked(client.events.list).mockClear();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(within(log).getByText("task.completed")).toBeTruthy());
    expect(client.events.list).toHaveBeenCalledTimes(1);
    expect(client.events.list).toHaveBeenCalledWith({
      missionId: m1.id,
      cursor: `c${HISTORY_MAX_PAGES}`,
      limit: 500,
    });
    const done = screen.getByText(/Continued: loaded 1 events\./);
    expect(done.textContent).not.toContain("?");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    // Earlier pages stay: the continue appends rather than replaces.
    expect(
      screen.getByText(new RegExp(`${HISTORY_MAX_PAGES + 2} of ${HISTORY_MAX_PAGES + 2} events`)),
    ).toBeTruthy();
  });
});

describe("Activity: continue (All projects)", () => {
  it("continues an unscoped replay from the cursor where it stopped", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    vi.mocked(client.events.list).mockImplementation(async (q) => {
      const n = q?.cursor ? Number(q.cursor.slice(1)) : 0;
      return n >= HISTORY_MAX_PAGES
        ? page([event("task.completed", { from: "verifying", to: "completed" })], null)
        : page([event("task.ready", { from: "pending", to: "ready" })], `c${n + 1}`);
    });
    renderWithStore(<Activity />, { client });
    await user.click(await screen.findByRole("button", { name: "Replay" }));
    const result = await screen.findByText(/Replayed \d+ events/);
    expect(result.textContent).toContain(`Continue resumes from cursor c${HISTORY_MAX_PAGES}`);
    vi.mocked(client.events.list).mockClear();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/Continued: loaded 1 events\./);
    expect(client.events.list).toHaveBeenCalledWith({
      cursor: `c${HISTORY_MAX_PAGES}`,
      limit: 500,
    });
  });
});
