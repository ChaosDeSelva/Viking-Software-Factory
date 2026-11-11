import { newId, type CapabilitiesResponse, type Worktree } from "@mimir/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes, defaultBaseUrl } from "./App.js";
import { useSession } from "./api/session.js";
import { ActionResult } from "./components/ActionResult.js";
import { DagSvg } from "./components/DagSvg.js";
import { Tabs } from "./components/Tabs.js";
import { createClient } from "./api/client.js";
import { EventList } from "./components/EventList.js";
import { HelpDialog } from "./components/HelpDialog.js";
import { Layout } from "./components/Layout.js";
import { TokenPrompt } from "./components/TokenPrompt.js";
import { HISTORY_MAX_PAGES } from "./lib/useEventHistory.js";
import { Activity } from "./screens/Activity.js";
import { AgentInspector, TERMINAL_MIN_INTERVAL_MS } from "./screens/AgentInspector.js";
import { CrewDetail, Crews } from "./screens/Crews.js";
import { Projects } from "./screens/Projects.js";
import { Reviews } from "./screens/Reviews.js";
import { Settings } from "./screens/Settings.js";
import { MissionDetail } from "./screens/MissionDetail.js";
import { Missions } from "./screens/Missions.js";
import { Overview } from "./screens/Overview.js";
import { initialState, reducer } from "./store/reducer.js";
import { StoreProvider } from "./store/StoreProvider.js";
import {
  agent,
  approval,
  crew,
  dependency,
  event,
  mission,
  project,
  snapshot,
  task,
} from "./test/fixtures.js";
import { mockClient, page, type MockClient } from "./test/mockClient.js";
import { renderWithStore } from "./test/render.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function caps(runtime: CapabilitiesResponse["runtime"] | undefined): CapabilitiesResponse {
  return {
    serverVersion: "0.1.0",
    protocolVersion: 1,
    ...(runtime ? { runtime } : {}),
  } as CapabilitiesResponse;
}

const noFeatures = {
  createSession: false,
  sendInput: false,
  sendKeys: false,
  softStop: false,
  forceStop: false,
  pause: false,
  subscribe: false,
  terminalRead: false,
  processInfo: false,
  multiHost: false,
  notify: false,
};

describe("App routes and defaults", () => {
  it("shows a not-found page with a way back for an unknown path", async () => {
    render(
      <StoreProvider client={mockClient()}>
        <MemoryRouter initialEntries={["/nowhere"]}>
          <AppRoutes />
        </MemoryRouter>
      </StoreProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the overview" }).getAttribute("href")).toBe("/");
  });

  it("uses the configured server URL, or the page origin when none is set", () => {
    vi.stubEnv("VITE_MIMIR_URL", "http://127.0.0.1:7700");
    expect(defaultBaseUrl()).toBe("http://127.0.0.1:7700");
    vi.stubEnv("VITE_MIMIR_URL", "");
    expect(defaultBaseUrl()).toBe(window.location.origin);
  });

  it("gives a harmless sign-out outside a session", () => {
    function Probe() {
      const { signOut } = useSession();
      return (
        <button type="button" onClick={signOut}>
          sign out
        </button>
      );
    }
    render(<Probe />);
    expect(() => screen.getByRole("button", { name: "sign out" }).click()).not.toThrow();
  });
});

describe("Tabs keyboard", () => {
  function Harness() {
    const [active, setActive] = useState("a");
    return (
      <Tabs
        tabs={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ]}
        active={active}
        onChange={setActive}
        label="Views"
      >
        <span data-testid="panel">{active}</span>
      </Tabs>
    );
  }

  it("moves with arrows (wrapping), Home and End, and ignores other keys", () => {
    render(<Harness />);
    const panel = () => screen.getByTestId("panel").textContent;
    const tab = (name: string) => screen.getByRole("tab", { name });
    fireEvent.keyDown(tab("A"), { key: "ArrowLeft" });
    expect(panel()).toBe("c");
    expect(document.activeElement).toBe(tab("C"));
    fireEvent.keyDown(tab("C"), { key: "Home" });
    expect(panel()).toBe("a");
    fireEvent.keyDown(tab("A"), { key: "End" });
    expect(panel()).toBe("c");
    fireEvent.keyDown(tab("C"), { key: "x" });
    expect(panel()).toBe("c");
  });
});

describe("ActionResult and DagSvg details", () => {
  it("shows an operation id without a command id", () => {
    render(<ActionResult outcome={{ kind: "ok", message: "Done", operationId: "op_1" }} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Done (operation op_1)");
  });

  it("shortens long task titles and draws only edges between shown tasks", () => {
    const long = task({ title: "A very long task title that does not fit" });
    const other = task({ title: "Short" });
    render(
      <DagSvg
        tasks={[long, other]}
        deps={[dependency(other.id, long.id), dependency(other.id, newId("tsk"))]}
      />,
    );
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toBe("Task dependency graph: 2 tasks, 1 dependencies");
    expect(svg.textContent).toContain("A very long task titl…");
    expect(svg.textContent).toContain("Short");
  });
});

describe("Overview details", () => {
  function renderOverview(client: MockClient) {
    return renderWithStore(<Overview />, { client });
  }

  it("shows a health failure with retry", async () => {
    const client = mockClient();
    vi.mocked(client.health).mockRejectedValueOnce(new Error("health down"));
    renderOverview(client);
    const region = await screen.findByRole("region", { name: "Fleet health" });
    expect((await within(region).findByRole("alert")).textContent).toContain("health down");
  });

  it("shows a capabilities failure", async () => {
    const client = mockClient();
    vi.mocked(client.capabilities).mockRejectedValueOnce(new Error("caps down"));
    renderOverview(client);
    const region = await screen.findByRole("region", { name: "Fleet health" });
    expect((await within(region).findByRole("alert")).textContent).toContain("caps down");
  });

  it("says when no runtime is configured", async () => {
    const client = mockClient();
    vi.mocked(client.capabilities).mockResolvedValue(caps(undefined));
    renderOverview(client);
    expect(await screen.findByText("No runtime configured")).toBeTruthy();
    expect(screen.queryByText("Capabilities")).toBeNull();
  });

  it("reports an unhealthy runtime, no capabilities and no agent kinds", async () => {
    const client = mockClient();
    vi.mocked(client.health).mockResolvedValue({
      status: "ok",
      runtime: { ok: false },
    } as Awaited<ReturnType<MockClient["health"]>>);
    vi.mocked(client.capabilities).mockResolvedValue(
      caps({ runtime: "fake", version: "1", features: noFeatures, agentKinds: [] }),
    );
    renderOverview(client);
    expect(await screen.findByText("fake 1 (unhealthy: no detail)")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Fleet health" });
    expect(within(region).getAllByText("none")).toHaveLength(2);
  });

  it("reports a healthy runtime and one without a health report", async () => {
    const client = mockClient();
    vi.mocked(client.health).mockResolvedValueOnce({
      status: "ok",
      runtime: { ok: true },
    } as Awaited<ReturnType<MockClient["health"]>>);
    const view = renderOverview(client);
    expect(await screen.findByText(/\(healthy\)$/)).toBeTruthy();
    view.unmount();
    renderOverview(client);
    const region = await screen.findByRole("region", { name: "Fleet health" });
    await waitFor(() => expect(within(region).getByText("Runtime")).toBeTruthy());
    expect(region.textContent).not.toMatch(/healthy/);
  });

  it("links server attention items to their agent or mission, and leaves others unlinked", async () => {
    const client = mockClient();
    const sessionId = newId("ses");
    const missionId = newId("msn");
    vi.mocked(client.attention.list).mockResolvedValue({
      items: [
        { id: "s1", kind: "stuck", title: "Stuck session", sessionId },
        { id: "s2", kind: "budget", title: "Over budget", missionId },
        { id: "s3", kind: "unknown", title: "Something odd" },
      ],
    });
    renderOverview(client);
    const region = await screen.findByRole("region", { name: "Needs attention" });
    const row = async (title: string) => (await within(region).findByText(title)).closest("li");
    expect(
      within((await row("Stuck session")) as HTMLElement)
        .getByRole("link", { name: "Inspect agent" })
        .getAttribute("href"),
    ).toBe(`/agents/${sessionId}`);
    expect(
      within((await row("Over budget")) as HTMLElement)
        .getByRole("link", { name: "Open mission" })
        .getAttribute("href"),
    ).toBe(`/missions/${missionId}`);
    expect(within((await row("Something odd")) as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("names an active crew's mission by id when the mission is not loaded", async () => {
    const c = crew({ status: "running" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ crews: [c] })) });
    renderOverview(client);
    const region = await screen.findByRole("region", { name: "Active crews" });
    expect(within(region).getByText(c.missionId)).toBeTruthy();
  });
});

describe("MissionDetail details", () => {
  function renderMission(client: MockClient, id: string) {
    return renderWithStore(<MissionDetail />, {
      client,
      route: `/missions/${id}`,
      path: "/missions/:id",
    });
  }

  it("starts a draft mission", async () => {
    const user = userEvent.setup();
    const m = mission({ status: "draft" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderMission(client, m.id);
    await user.click(await screen.findByRole("button", { name: "Start mission" }));
    expect(client.missions.start).toHaveBeenCalledWith(m.id, {});
    expect((await screen.findByRole("status")).textContent).toContain("Start requested");
  });

  it("lists blocked reasons in the plan and agents without a session", async () => {
    const user = userEvent.setup();
    const m = mission();
    const c = crew({ missionId: m.id });
    const t = task({ missionId: m.id, title: "Stuck one", status: "blocked", blockedReason: "x" });
    const a = agent({ crewId: c.id, runtimeSessionId: null, role: "reviewer" });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c], tasks: [t], agents: [a] })),
    });
    renderMission(client, m.id);
    const plan = await screen.findByRole("tabpanel");
    expect(await within(plan).findByText("Stuck one: blocked (x)")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getByText("no session")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByRole("option", { name: c.template })).toBeTruthy();
  });

  it("shows test totals, duration and output, and a passing run", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.events.list).mockResolvedValue(
      page([
        event(
          "test.run_completed",
          { command: "pnpm test", passed: true, total: 4, durationMs: 12.6 },
          { missionId: m.id },
        ),
        event(
          "test.run_completed",
          { command: "pnpm lint", passed: false, total: 2, failed: 1, output: "lint said no" },
          { missionId: m.id },
        ),
      ]),
    );
    renderMission(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Tests" }));
    const passed = (await screen.findByText("pnpm test")).closest("li");
    expect(passed?.textContent).toContain("passed");
    expect(passed?.textContent).toContain("0 of 4 failed");
    expect(passed?.textContent).toContain("13 ms");
    const failed = screen.getByText("pnpm lint").closest("li");
    expect(failed?.textContent).toContain("1 of 2 failed");
    expect(within(failed as HTMLElement).getByText("lint said no").tagName).toBe("PRE");
  });

  it("says when there are no file artifacts and shows a costs failure", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.usage.get).mockRejectedValue(new Error("usage down"));
    renderMission(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Files" }));
    expect(await screen.findByText("No artifacts recorded yet.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Costs" }));
    expect((await screen.findByRole("alert")).textContent).toContain("usage down");
  });
});

describe("AgentInspector details", () => {
  function setup(over: { worktree?: boolean } = {}) {
    const t = task({ title: "Implement parser", status: "running" });
    const ag = agent({ taskId: t.id, status: "running" });
    const sessionId = ag.runtimeSessionId as string;
    const wt: Worktree = {
      id: newId("wtr"),
      taskId: t.id,
      path: "/tmp/wt/parser",
      branch: "mimir/parser",
      baseSha: "a".repeat(40),
      status: "active",
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
      version: 0,
    } as Worktree;
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({ tasks: [t], agents: [ag], worktrees: over.worktree ? [wt] : [] }),
      ),
    });
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${sessionId}`,
      path: "/agents/:sessionId",
    });
    return { t, ag, sessionId, client, wt };
  }

  it("shows the task's worktree", async () => {
    const { wt } = setup({ worktree: true });
    const region = await screen.findByRole("region", { name: "State" });
    expect(within(region).getByText(`${wt.path} (${wt.branch})`)).toBeTruthy();
  });

  it("shows live events of the session and of its task in the timeline", async () => {
    const { t, sessionId, client } = setup();
    await screen.findByRole("region", { name: "Timeline" });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => {
      client.streamController.push(
        event(
          "session.output",
          { text: "from session", redacted: false, lines: 1 },
          {
            sessionId: sessionId as never,
          },
        ),
      );
      client.streamController.push(
        event("task.verifying", { from: "running", to: "verifying" }, { taskId: t.id }),
      );
      client.streamController.push(
        event("session.output", { text: "elsewhere", redacted: false, lines: 1 }),
      );
    });
    const timeline = screen.getByRole("region", { name: "Timeline" });
    await waitFor(() => expect(within(timeline).getByText("from session")).toBeTruthy());
    expect(within(timeline).getByText("running → verifying")).toBeTruthy();
    expect(within(timeline).queryByText("elsewhere")).toBeNull();
  });

  it("refreshes the terminal once the cool-down has passed", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    await user.click(await screen.findByRole("button", { name: "Read terminal" }));
    const refresh = (await screen.findByRole("button", {
      name: "Refresh terminal",
    })) as HTMLButtonElement;
    await waitFor(() => expect(refresh.disabled).toBe(false), {
      timeout: TERMINAL_MIN_INTERVAL_MS + 5000,
    });
    await user.click(refresh);
    expect(client.sessions.terminal).toHaveBeenCalledTimes(2);
  });

  it("force-stops after confirmation and returns focus to the force-stop button", async () => {
    const user = userEvent.setup();
    const { client, sessionId } = setup();
    await user.click(await screen.findByRole("button", { name: "Force stop…" }));
    await user.click(screen.getByRole("button", { name: "Confirm force stop" }));
    expect(client.sessions.stop).toHaveBeenCalledWith(sessionId, { mode: "force" });
    expect((await screen.findByRole("status")).textContent).toContain("Force stop requested");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Force stop…" }));
  });

  it("shows a cost failure", async () => {
    const t = task();
    const ag = agent({ taskId: t.id });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ tasks: [t], agents: [ag] })),
    });
    vi.mocked(client.usage.get).mockRejectedValue(new Error("cost down"));
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${ag.runtimeSessionId}`,
      path: "/agents/:sessionId",
    });
    const region = await screen.findByRole("region", { name: "Cost" });
    expect((await within(region).findByRole("alert")).textContent).toContain("cost down");
  });
});

describe("small components", () => {
  it("passes a custom fetch to the SDK client", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    const client = createClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetch });
    await client.health().catch(() => undefined);
    expect(fetch).toHaveBeenCalled();
  });

  it("summarizes event payloads by reason, action and command, and shows nothing for others", () => {
    const base = event("task.ready", { from: "pending", to: "ready" });
    const rows = [
      { ...base, id: "e1", payload: null },
      { ...base, id: "e2", payload: { reason: "budget hit" } },
      { ...base, id: "e3", payload: { action: "shell.exec" } },
      { ...base, id: "e4", payload: { command: "pnpm test", passed: true } },
      { ...base, id: "e5", payload: { command: "pnpm lint", passed: false } },
      { ...base, id: "e6", payload: { other: 1 } },
    ] as never[];
    render(<EventList events={rows} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items.some((t) => t?.includes("budget hit"))).toBe(true);
    expect(items.some((t) => t?.includes("shell.exec"))).toBe(true);
    expect(items.some((t) => t?.includes("pnpm test → passed"))).toBe(true);
    expect(items.some((t) => t?.includes("pnpm lint → failed"))).toBe(true);
    expect(items).toHaveLength(6);
  });

  it("keeps Tab focus inside the help dialog in both directions", () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">outside</button>
        <HelpDialog onClose={onClose} />
      </>,
    );
    const dialog = screen.getByRole("dialog");
    const inside = within(dialog).getAllByRole("button");
    const first = inside[0] as HTMLElement;
    const last = inside[inside.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    screen.getByRole("button", { name: "outside" }).focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not submit a blank token", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TokenPrompt onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Auth token"), "   ");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers Reconnect when the stream closed and lists at most three attention items", async () => {
    const user = userEvent.setup();
    const tasks = ["A", "B", "C", "D"].map((title) => task({ title, status: "blocked" }));
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ tasks })) });
    vi.mocked(client.events.stream).mockReturnValueOnce({
      cursor: undefined,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true as const }),
      }),
    });
    renderWithStore(<Layout />, { client });
    await waitFor(() =>
      expect(screen.getByTestId("attention-live").textContent).toContain("and more"),
    );
    expect(screen.getByTestId("attention-live").textContent).toMatch(/^4 items need attention: /);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
  });
});

describe("screen details", () => {
  it("Activity reports a replay from a cursor that stopped at the page limit", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    let n = 0;
    vi.mocked(client.events.list).mockImplementation(async () =>
      page([event("task.ready", { from: "pending", to: "ready" })], `c${++n}`),
    );
    renderWithStore(<Activity />, { client });
    await user.type(await screen.findByLabelText("Replay from cursor"), "c0");
    await user.click(screen.getByRole("button", { name: "Replay" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      `Replayed ${HISTORY_MAX_PAGES} events from cursor c0 (stopped early; continue from c${HISTORY_MAX_PAGES}).`,
    );
  });

  it("Settings shows a health failure and a server without a runtime", async () => {
    const failing = mockClient();
    vi.mocked(failing.health).mockRejectedValueOnce(new Error("health down"));
    const first = renderWithStore(<Settings />, { client: failing });
    expect((await screen.findByRole("alert")).textContent).toContain("health down");
    first.unmount();
    const bare = mockClient();
    vi.mocked(bare.capabilities).mockResolvedValue(caps(undefined));
    renderWithStore(<Settings />, { client: bare });
    expect(await screen.findByText("No runtime configured")).toBeTruthy();
  });

  it("Projects shows test commands given as argv or a string, and dashes for missing settings", async () => {
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({
          projects: [
            project({
              name: "argv",
              settings: { testCommand: ["pnpm", "test"], protectedBranches: ["main", "rel"] },
            }),
            project({ name: "string", settings: { testCommand: "make test" } }),
            project({ name: "none", settings: {} }),
          ],
        }),
      ),
    });
    renderWithStore(<Projects />, { client });
    const row = async (name: string) =>
      (await screen.findByRole("cell", { name })).closest("tr") as HTMLElement;
    expect((await row("argv")).textContent).toContain("pnpm test");
    expect((await row("argv")).textContent).toContain("main, rel");
    expect((await row("string")).textContent).toContain("make test");
    expect(within(await row("none")).getAllByText("—")).toHaveLength(2);
  });

  it("Crews: validates mission and roles, unticks a role, and defaults a blank template", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.crews.create).mockResolvedValue({
      crew: crew({ missionId: m.id }),
      members: [],
    });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Choose a mission.");
    await user.selectOptions(screen.getByLabelText("Mission"), m.id);
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Pick at least one role.");
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.clear(screen.getByLabelText("Template name"));
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    await waitFor(() => expect(client.crews.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.crews.create).mock.calls[0]?.[0].template).toBe("default");
  });

  it("Crews: names a crew's mission by id when it is not loaded, and says the roster is empty", async () => {
    const c = crew();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ crews: [c] })) });
    const list = renderWithStore(<Crews />, { client });
    expect(await screen.findByText(c.missionId)).toBeTruthy();
    list.unmount();
    renderWithStore(<CrewDetail />, { client, route: `/crews/${c.id}`, path: "/crews/:id" });
    expect(await screen.findByText("No agents have been started for this crew yet.")).toBeTruthy();
    expect(screen.getByText(c.missionId).tagName).toBe("SPAN");
  });

  it("AgentInspector sends a trimmed instruction, clears it, and ignores a blank one", async () => {
    const user = userEvent.setup();
    const ag = agent();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ agents: [ag] })) });
    vi.mocked(client.sessions.terminal).mockResolvedValue({
      text: "x",
      capturedAt: "2026-10-14T10:00:00.000Z",
    } as never);
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${ag.runtimeSessionId}`,
      path: "/agents/:sessionId",
    });
    const box = (await screen.findByLabelText("Instruction")) as HTMLTextAreaElement;
    await user.type(box, "   ");
    await user.click(screen.getByRole("button", { name: "Send instruction" }));
    expect(client.sessions.input).not.toHaveBeenCalled();
    await user.type(box, " go on ");
    await user.click(screen.getByRole("button", { name: "Send instruction" }));
    expect(client.sessions.input).toHaveBeenCalledWith(ag.runtimeSessionId, { text: "go on" });
    await waitFor(() => expect(box.value).toBe(""));
    await user.click(screen.getByRole("button", { name: "Read terminal" }));
    expect(await screen.findByText("captured 2026-10-14T10:00:00.000Z")).toBeTruthy();
  });

  it("Reviews shows expiry, test totals, risky approvals with reasons, and retries a failed history", async () => {
    const user = userEvent.setup();
    const pending = approval({ expiry: "2026-10-15T00:00:00.000Z" });
    const risky = approval({ action: "shell.rm", status: "rejected", reason: "too wide" });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ approvals: [pending, risky] })),
    });
    vi.mocked(client.events.list)
      .mockRejectedValueOnce(new Error("history down"))
      .mockResolvedValue(
        page([event("test.run_completed", { command: "pnpm test", passed: false, total: 3 })]),
      );
    renderWithStore(<Reviews />, { client });
    expect(await screen.findByText(/expires 2026-10-15T00:00:00.000Z/)).toBeTruthy();
    expect(await screen.findByText("Error: history down")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    const testRow = (await screen.findByText("pnpm test")).closest("li");
    expect(testRow?.textContent).toContain("0 of 3 failed");
    const riskyRegion = screen.getByRole("region", { name: "High-risk commands" });
    expect(riskyRegion.textContent).toContain("shell.rm (rejected): too wide");
  });
});

describe("remaining branches", () => {
  it("builds an SDK client without a custom fetch", () => {
    const client = createClient({ baseUrl: "http://127.0.0.1:1", token: "t" });
    expect(typeof client.snapshot).toBe("function");
  });

  it("moves Shift+Tab from outside the help dialog to its last control", () => {
    render(
      <>
        <button type="button">outside</button>
        <HelpDialog onClose={vi.fn()} />
      </>,
    );
    const inside = within(screen.getByRole("dialog")).getAllByRole("button");
    screen.getByRole("button", { name: "outside" }).focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside[inside.length - 1]);
  });

  it("Activity replays from the beginning when no cursor is given", async () => {
    const user = userEvent.setup();
    const client = mockClient();
    renderWithStore(<Activity />, { client });
    await user.click(await screen.findByRole("button", { name: "Replay" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Replayed 0 events from the beginning.",
    );
    expect(client.events.list).toHaveBeenCalledWith({ limit: expect.any(Number) });
  });

  it("Crews rejects a blank max concurrent tasks and keeps the form after a failed create", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.crews.create).mockRejectedValue(new Error("crew refused"));
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await user.selectOptions(screen.getByLabelText("Mission"), m.id);
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.clear(screen.getByLabelText("Max concurrent tasks"));
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Max concurrent tasks/);
    await user.type(screen.getByLabelText("Max concurrent tasks"), "2");
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect((await screen.findByRole("alert")).textContent).toContain("crew refused");
    expect(client.snapshot).toHaveBeenCalledTimes(1);
  });

  it("AgentInspector keeps the instruction when sending fails", async () => {
    const user = userEvent.setup();
    const ag = agent();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ agents: [ag] })) });
    vi.mocked(client.sessions.input).mockRejectedValue(new Error("input refused"));
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${ag.runtimeSessionId}`,
      path: "/agents/:sessionId",
    });
    const box = (await screen.findByLabelText("Instruction")) as HTMLTextAreaElement;
    await user.type(box, "go");
    await user.click(screen.getByRole("button", { name: "Send instruction" }));
    expect((await screen.findByRole("alert")).textContent).toContain("input refused");
    expect(box.value).toBe("go");
  });

  it("MissionDetail says when there are no test runs and no agents", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderWithStore(<MissionDetail />, {
      client,
      route: `/missions/${m.id}`,
      path: "/missions/:id",
    });
    await user.click(await screen.findByRole("tab", { name: "Tests" }));
    expect(await screen.findByText("No test runs recorded yet.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(screen.getByText("No agents yet.")).toBeTruthy();
  });

  it("Overview lists configured crews as active", async () => {
    const c = crew({ status: "configured", template: "solo" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ crews: [c] })) });
    renderWithStore(<Overview />, { client });
    const region = await screen.findByRole("region", { name: "Active crews" });
    expect(within(region).getByRole("link", { name: "solo crew" })).toBeTruthy();
  });

  it("Missions board shows a blocked task's reason", async () => {
    const m = mission();
    const t = task({
      missionId: m.id,
      title: "Waits",
      status: "blocked",
      blockedReason: "needs ok",
    });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ missions: [m], tasks: [t] })),
    });
    renderWithStore(<Missions />, { client });
    const row = (await screen.findByText("Waits")).closest("li");
    expect(row?.textContent).toContain("blocked · needs ok");
  });

  it("Reviews shows a passing run and a risky approval without a reason", async () => {
    const risky = approval({ action: "shell.exec", reason: null });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ approvals: [risky] })) });
    vi.mocked(client.events.list).mockResolvedValue(
      page([event("test.run_completed", { command: "pnpm ok", passed: true })]),
    );
    renderWithStore(<Reviews />, { client });
    const row = (await screen.findByText("pnpm ok")).closest("li");
    expect(row?.textContent).toContain("completed");
    const region = screen.getByRole("region", { name: "High-risk commands" });
    expect(region.textContent).toContain(`shell.exec (${risky.status})`);
    expect(region.textContent).not.toContain(`(${risky.status}):`);
  });

  it("Reviews drops a history result that arrives after unmount", async () => {
    const onUnauthorized = vi.fn();
    const client = mockClient();
    let settle: (fail: boolean) => void = () => undefined;
    vi.mocked(client.events.list).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = (fail) =>
            fail
              ? reject(
                  Object.assign(new Error("401"), { name: "MimirError", code: "unauthorized" }),
                )
              : resolve(page([]));
        }),
    );
    const first = renderWithStore(<Reviews />, { client, onUnauthorized });
    await waitFor(() => expect(client.events.list).toHaveBeenCalledTimes(1));
    first.unmount();
    await act(async () => settle(true));
    expect(onUnauthorized).not.toHaveBeenCalled();
    const second = renderWithStore(<Reviews />, { client, onUnauthorized });
    await waitFor(() => expect(client.events.list).toHaveBeenCalledTimes(2));
    second.unmount();
    await act(async () => settle(false));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("StoreProvider ignores an event the stream yields after unmount", async () => {
    let yieldEvent: (e: ReturnType<typeof event>) => void = () => undefined;
    const client = mockClient();
    vi.mocked(client.events.stream).mockReturnValueOnce({
      cursor: undefined,
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) => {
            yieldEvent = (value) => resolve({ value, done: false });
          }),
      }),
    });
    const view = render(
      <StoreProvider client={client} refreshDelayMs={0}>
        <span />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.events.stream).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      yieldEvent(
        event("task.created", {
          missionId: newId("msn"),
          crewId: null,
          title: "late",
          acceptance: "",
          dependsOn: [],
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(client.snapshot).toHaveBeenCalledTimes(1);
  });

  it("reducer ignores mission events for unknown missions and session events for other sessions", () => {
    const a = agent({ status: "running" });
    const s0 = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ missions: [mission()], agents: [a] }),
    });
    const s1 = reducer(s0, {
      type: "event/received",
      event: event("mission.started", { from: "draft", to: "active" }, { missionId: newId("msn") }),
    });
    expect(s1.missions).toBe(s0.missions);
    const s2 = reducer(s1, {
      type: "event/received",
      event: event(
        "session.state_changed",
        { from: "running", to: "stopped" },
        { sessionId: newId("ses") },
      ),
    });
    expect(s2.agents).toBe(s0.agents);
  });
});

describe("Reviews focus", () => {
  it("leaves focus where it is when an approval is decided elsewhere while focus is outside the card", async () => {
    const a = approval();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ approvals: [a] })) });
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    try {
      renderWithStore(<Reviews />, { client });
      const region = await screen.findByRole("region", { name: "Pending approvals" });
      await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(1));
      await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
      outside.focus();
      act(() =>
        client.streamController.push(
          event("approval.decided", { approvalId: a.id, decision: "approved", actor: "human" }),
        ),
      );
      await waitFor(() => expect(within(region).queryAllByRole("listitem")).toHaveLength(0));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe("StoreProvider unmount during the first load", () => {
  it("does not open the stream when unmounted before the snapshot answers", async () => {
    let answer: (s: ReturnType<typeof snapshot>) => void = () => undefined;
    const client = mockClient({
      snapshot: vi.fn(() => new Promise<ReturnType<typeof snapshot>>((r) => (answer = r))),
    });
    const view = render(
      <StoreProvider client={client}>
        <span />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => answer(snapshot()));
    expect(client.events.stream).not.toHaveBeenCalled();
  });
});
