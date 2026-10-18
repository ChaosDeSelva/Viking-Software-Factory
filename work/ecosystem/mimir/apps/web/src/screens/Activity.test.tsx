import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { event } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
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
    const log = screen.getByRole("region", { name: "Event log" });
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
    const log = screen.getByRole("region", { name: "Event log" });
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
    await user.selectOptions(await screen.findByLabelText("Type"), "task.ready");
    await user.click(screen.getByRole("button", { name: /Export JSON/ }));
    expect(click).toHaveBeenCalled();
    expect(revokedBeforeClickReturned).toBe(false);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x"));
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(await (blob as unknown as Blob).text());
    expect(parsed.map((e: { id: string }) => e.id)).toEqual([keep.id]);
  });
});
