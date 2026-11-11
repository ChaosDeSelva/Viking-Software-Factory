import { newId, type CapabilitiesResponse } from "@mimir/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_MAX_PAGES, HISTORY_PAGE } from "../lib/useEventHistory.js";
import { agent, crew, event, mission, snapshot, task } from "../test/fixtures.js";
import { mockClient, page, type MockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Activity } from "./Activity.js";
import { AgentInspector } from "./AgentInspector.js";
import { Crews } from "./Crews.js";
import { MissionDetail } from "./MissionDetail.js";
import { Missions } from "./Missions.js";
import { Projects } from "./Projects.js";
import { Reviews } from "./Reviews.js";

const unauthorized = () =>
  Object.assign(new Error("bad token"), { name: "MimirError", code: "unauthorized", status: 401 });

function renderMission(client: MockClient, id: string, onUnauthorized?: () => void) {
  return renderWithStore(<MissionDetail />, {
    client,
    route: `/missions/${id}`,
    path: "/missions/:id",
    ...(onUnauthorized ? { onUnauthorized } : {}),
  });
}

describe("a rejected token returns to the token prompt from every request", () => {
  it("creating a project", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const client = mockClient();
    vi.mocked(client.projects.create).mockRejectedValue(unauthorized());
    renderWithStore(<Projects />, { client, onUnauthorized });
    await screen.findByText(/No projects yet/);
    await user.click(screen.getAllByRole("button", { name: "New project" })[0]!);
    await user.type(screen.getByLabelText(/^Name/), "x");
    await user.type(screen.getByLabelText(/^Repository path/), "/repo");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("replaying events", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const client = mockClient();
    vi.mocked(client.events.list).mockRejectedValue(unauthorized());
    renderWithStore(<Activity />, { client, onUnauthorized });
    await user.click(await screen.findByRole("button", { name: "Replay" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("loading the review history", async () => {
    const onUnauthorized = vi.fn();
    const client = mockClient();
    vi.mocked(client.events.list).mockRejectedValue(unauthorized());
    renderWithStore(<Reviews />, { client, onUnauthorized });
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("loading a mission's event history", async () => {
    const onUnauthorized = vi.fn();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.events.list).mockRejectedValue(unauthorized());
    renderMission(client, m.id, onUnauthorized);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("viewing an artifact", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const m = mission();
    const artifactId = newId("art");
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.events.list).mockResolvedValue(
      page([
        event(
          "artifact.recorded",
          { artifactId, taskId: newId("tsk"), kind: "log", uri: "file:///a.log", hash: "sha256:a" },
          { missionId: m.id },
        ),
      ]),
    );
    vi.mocked(client.artifacts.get).mockRejectedValue(unauthorized());
    renderMission(client, m.id, onUnauthorized);
    await user.click(await screen.findByRole("tab", { name: "Artifacts" }));
    await user.click(await screen.findByRole("button", { name: `View ${artifactId}` }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  it("reading a terminal", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const a = agent();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ agents: [a] })) });
    vi.mocked(client.sessions.terminal).mockRejectedValue(unauthorized());
    renderWithStore(<AgentInspector />, {
      client,
      route: `/agents/${a.runtimeSessionId}`,
      path: "/agents/:sessionId",
      onUnauthorized,
    });
    await user.click(await screen.findByRole("button", { name: "Read terminal" }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain("bad token");
  });

  it("other failures stay on the screen and do not sign out", async () => {
    const user = userEvent.setup();
    const onUnauthorized = vi.fn();
    const client = mockClient();
    vi.mocked(client.events.list).mockRejectedValue(new Error("server down"));
    renderWithStore(<Activity />, { client, onUnauthorized });
    await user.click(await screen.findByRole("button", { name: "Replay" }));
    expect((await screen.findByRole("alert")).textContent).toContain("server down");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("Missions board: attempts", () => {
  it("numbers attempts from 1, so the last allowed attempt reads N/N", async () => {
    const m = mission();
    const first = task({ missionId: m.id, title: "First try", status: "running", attempt: 0 });
    const last = task({
      missionId: m.id,
      title: "Last try",
      status: "running",
      attempt: 2,
      maxAttempts: 3,
    });
    renderWithStore(<Missions />, {
      client: mockClient({
        snapshot: vi.fn(async () => snapshot({ missions: [m], tasks: [first, last] })),
      }),
    });
    const running = await screen.findByRole("list", { name: "Running" });
    const lastRow = within(running).getByText("Last try").closest("li");
    expect(lastRow?.textContent).toContain("attempt 3/3");
    expect(within(running).getByText("First try").closest("li")?.textContent).not.toContain(
      "attempt",
    );
  });
});

describe("Crews form", () => {
  /** The form is in the "New crew" dialog; Mission is a Combobox picked by the mission's name. */
  async function openAndPick(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getAllByRole("button", { name: "New crew" })[0]!);
    await user.click(await screen.findByLabelText("Mission"));
    await user.click(await screen.findByRole("option", { name }));
  }

  function caps(agentKinds: string[]): CapabilitiesResponse {
    return {
      serverVersion: "0.1.0",
      protocolVersion: 1,
      runtime: {
        runtime: "fake",
        version: "1",
        features: {
          createSession: true,
          sendInput: true,
          sendKeys: true,
          softStop: true,
          forceStop: true,
          pause: false,
          subscribe: true,
          terminalRead: true,
          processInfo: false,
          multiHost: false,
          notify: false,
        },
        agentKinds,
      },
    };
  }

  it("sends the agent kind the select shows when capabilities arrive after a role was ticked", async () => {
    const user = userEvent.setup();
    const m = mission({ objective: "Objective X" });
    let release: (c: CapabilitiesResponse) => void = () => undefined;
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ missions: [m] })),
      capabilities: vi.fn(
        () =>
          new Promise<CapabilitiesResponse>((resolve) => {
            release = resolve;
          }),
      ),
    });
    vi.mocked(client.crews.create).mockResolvedValue({
      crew: crew({ missionId: m.id }),
      members: [],
    });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await openAndPick(user, "Objective X");
    await user.click(screen.getByRole("checkbox", { name: "implementer" }));
    release(caps(["claude", "codex"]));
    // The kind ticked before capabilities ("shell") is not offered: the select shows the first.
    const select = await screen.findByRole("combobox", { name: "Agent kind for implementer" });
    await waitFor(() => expect(select.textContent).toMatch("claude"));
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    await waitFor(() => expect(client.crews.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.crews.create).mock.calls[0]?.[0].members).toEqual([
      { role: "implementer", agentKind: "claude" },
    ]);
  });

  it("reads the max concurrent tasks field as a number, not by its leading digits", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.crews.create).mockResolvedValue({
      crew: crew({ missionId: m.id }),
      members: [],
    });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await openAndPick(user, "Ship the thing");
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.clear(screen.getByLabelText("Max concurrent tasks"));
    await user.type(screen.getByLabelText("Max concurrent tasks"), "1e1");
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    await waitFor(() => expect(client.crews.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.crews.create).mock.calls[0]?.[0].limits).toEqual({
      maxConcurrentTasks: 10,
    });
  });

  it.each(["1.5", "0"])("rejects %s as max concurrent tasks", async (value) => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await openAndPick(user, "Ship the thing");
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.clear(screen.getByLabelText("Max concurrent tasks"));
    await user.type(screen.getByLabelText("Max concurrent tasks"), value);
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Max concurrent tasks/);
    expect(client.crews.create).not.toHaveBeenCalled();
  });
});

describe("MissionDetail evidence", () => {
  it("says a test run was killed when it has no exit code", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.events.list).mockResolvedValue(
      page([
        event(
          "test.run_completed",
          { command: "pnpm test", passed: false, exitCode: null },
          { missionId: m.id },
        ),
        event(
          "test.run_completed",
          { command: "pnpm lint", passed: false, exitCode: 2 },
          { missionId: m.id },
        ),
      ]),
    );
    renderMission(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Tests" }));
    const killed = (await screen.findByText("pnpm test")).closest("li");
    expect(killed?.textContent).toContain("no exit code (killed)");
    expect(screen.getByText("pnpm lint").closest("li")?.textContent).toContain("exit code 2");
  });

  it("says so when the timeline stops at the history paging limit", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    let n = 0;
    vi.mocked(client.events.list).mockImplementation(async () => {
      n += 1;
      return page(
        [event("task.ready", { from: "pending", to: "ready" }, { missionId: m.id })],
        `c${n}`,
      );
    });
    renderMission(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));
    const note = await screen.findByText(/older events only/i);
    expect(note.textContent).toContain(String(HISTORY_MAX_PAGES * HISTORY_PAGE));
    expect(client.events.list).toHaveBeenCalledTimes(HISTORY_MAX_PAGES);
  });
});
