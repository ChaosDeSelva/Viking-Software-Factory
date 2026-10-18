import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { StoreGate } from "../components/StoreGate.js";
import { TokenPrompt } from "../components/TokenPrompt.js";
import { agent, approval, event, mission, snapshot, task } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { AgentInspector } from "./AgentInspector.js";
import { Crews } from "./Crews.js";
import { MissionDetail } from "./MissionDetail.js";
import { Missions } from "./Missions.js";
import { Reviews } from "./Reviews.js";
import { Settings } from "./Settings.js";

const unauthorized = () =>
  Object.assign(new Error("bad token"), { name: "MimirError", code: "unauthorized" });

describe("M-I3: initial snapshot Retry restarts the stream", () => {
  it("reloads the snapshot and opens the live stream", async () => {
    const client = mockClient({
      snapshot: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(snapshot()),
    });
    renderWithStore(
      <StoreGate label="data">
        <p>loaded ok</p>
      </StoreGate>,
      { client },
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/down/);
    expect(client.streamController.calls).toHaveLength(0);
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("loaded ok");
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
  });
});

function missionSetup(status: "draft" | "active" = "active") {
  const m = mission({ objective: "Build feature", status });
  const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
  return { m, client };
}

describe("M-I5: cancel mission confirmation", () => {
  it("does nothing until confirmed and restores focus on keep", async () => {
    const { m, client } = missionSetup();
    renderWithStore(<MissionDetail />, {
      client,
      route: `/missions/${m.id}`,
      path: "/missions/:id",
    });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel mission" }));
    expect(client.missions.cancel).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirm cancel mission" });
    expect(document.activeElement).toBe(confirm);
    await userEvent.click(screen.getByRole("button", { name: "Keep mission" }));
    expect(client.missions.cancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel mission" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel mission" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm cancel mission" }));
    await waitFor(() => expect(client.missions.cancel).toHaveBeenCalledWith(m.id, {}));
  });
});

describe("M-I4: history errors can be retried", () => {
  it("mission timeline", async () => {
    const { m, client } = missionSetup();
    vi.mocked(client.events.list).mockRejectedValueOnce(new Error("history down"));
    renderWithStore(<MissionDetail />, {
      client,
      route: `/missions/${m.id}`,
      path: "/missions/:id",
    });
    await userEvent.click(await screen.findByRole("tab", { name: "Timeline" }));
    const alert = await screen.findByText(/history down/);
    await userEvent.click(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Retry" }),
    );
    await waitFor(() => expect(screen.queryByText(/history down/)).toBeNull());
    expect(client.events.list).toHaveBeenCalledTimes(2);
  });

  it("reviews", async () => {
    const client = mockClient({ snapshot: vi.fn(async () => snapshot()) });
    vi.mocked(client.events.list)
      .mockRejectedValueOnce(new Error("history down"))
      .mockResolvedValue(page([]));
    renderWithStore(<Reviews />, { client });
    const alert = (await screen.findByText(/history down/)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/history down/)).toBeNull());
  });
});

describe("M-I6/M-m5: focus management in Reviews", () => {
  it("rejecting without a reason flags and focuses the field", async () => {
    const pending = approval();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ approvals: [pending] })) });
    renderWithStore(<Reviews />, { client });
    await userEvent.click(await screen.findByRole("button", { name: `Reject ${pending.id}` }));
    const input = screen.getByLabelText(/Reason/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
  });

  it("moves focus to the section heading when the focused approval card disappears", async () => {
    const pending = approval();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ approvals: [pending] })) });
    vi.mocked(client.approvals.decide).mockImplementation(() => new Promise(() => undefined));
    renderWithStore(<Reviews />, { client });
    await userEvent.click(await screen.findByRole("button", { name: `Approve ${pending.id}` }));
    act(() =>
      client.streamController.push(
        event("approval.decided", { approvalId: pending.id, decision: "approved", actor: "op" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `Approve ${pending.id}` })).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Pending approvals" }));
  });
});

describe("AgentInspector", () => {
  function setup(status: "running" | "unknown") {
    const t = task({ status: "running" });
    const ag = agent({ taskId: t.id, status });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ tasks: [t], agents: [ag] })),
    });
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${ag.runtimeSessionId as string}`,
      path: "/agents/:sessionId",
    });
    return { client };
  }

  it("M-I7: unknown state is not labelled observed", async () => {
    setup("unknown");
    const state = await screen.findByRole("region", { name: "State" });
    expect(within(state).queryByText("observed")).toBeNull();
    expect(within(state).getByText(/not reported/i)).toBeTruthy();
  });

  it("M-I6: force-stop confirm moves focus and restores it", async () => {
    setup("running");
    await userEvent.click(await screen.findByRole("button", { name: "Force stop…" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm force stop" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Force stop…" }));
  });

  it("M-m10: not-found has a back link", async () => {
    const client = mockClient({ snapshot: vi.fn(async () => snapshot()) });
    renderWithStore(<AgentInspector />, {
      client,
      route: "/agents/ses_x",
      path: "/agents/:sessionId",
    });
    const link = await screen.findByRole("link", { name: /back to missions/i });
    expect(link.getAttribute("href")).toBe("/missions");
  });
});

describe("M-I8: shortcut setting", () => {
  it("can be turned off in Settings and persists", async () => {
    localStorage.removeItem("mimir.shortcuts");
    const client = mockClient();
    renderWithStore(<Settings />, { client });
    const box = await screen.findByRole("checkbox", { name: /single-key keyboard shortcuts/i });
    expect((box as HTMLInputElement).checked).toBe(true);
    await userEvent.click(box);
    expect(localStorage.getItem("mimir.shortcuts")).toBe("off");
    await userEvent.click(box);
    expect(localStorage.getItem("mimir.shortcuts")).toBe("on");
    localStorage.removeItem("mimir.shortcuts");
  });
});

describe("M-m6: 401 in a panel re-prompts instead of offering a dead Retry", () => {
  it("calls onUnauthorized", async () => {
    const client = mockClient();
    vi.mocked(client.capabilities).mockRejectedValue(unauthorized());
    const onUnauthorized = vi.fn();
    renderWithStore(<Settings />, { client, onUnauthorized });
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});

describe("M-m8: capability load errors are shown", () => {
  it("Crews", async () => {
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.capabilities).mockRejectedValue(new Error("caps down"));
    renderWithStore(<Crews />, { client });
    expect((await screen.findAllByText(/caps down/)).length).toBeGreaterThan(0);
  });
});

describe("M-m9: start error sits on its mission row", () => {
  it("renders the failure inside the row", async () => {
    const m = mission({ objective: "Row mission", status: "draft" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.missions.start).mockRejectedValue(new Error("cannot start"));
    renderWithStore(<Missions />, { client });
    await userEvent.click(await screen.findByRole("button", { name: "Start Row mission" }));
    const row = (await screen.findByText(/cannot start/)).closest("li");
    expect(row?.textContent).toMatch(/Row mission/);
  });
});

describe("M-m11: token prompt autofocus", () => {
  it("focuses the token field", () => {
    render(
      <MemoryRouter>
        <TokenPrompt onSubmit={() => undefined} />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Auth token"));
  });
});
