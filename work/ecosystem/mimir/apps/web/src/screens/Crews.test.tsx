import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { agent, crew, event, mission, snapshot } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { CrewDetail, Crews } from "./Crews.js";

describe("Crews", () => {
  it("lists crews with their mission and limits", async () => {
    const m = mission({ objective: "Objective X" });
    const c = crew({ missionId: m.id, template: "squad", limits: { maxConcurrentTasks: 3 } });
    const { container } = renderWithStore(<Crews />, {
      client: mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c] })) }),
    });
    const link = await screen.findByRole("link", { name: "squad" });
    expect(link.getAttribute("href")).toBe(`/crews/${c.id}`);
    expect(screen.getAllByText("Objective X").length).toBeGreaterThan(0);
    expect(screen.getByText(/max 3 concurrent/)).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("creates a crew from role templates with max concurrency", async () => {
    const user = userEvent.setup();
    const m = mission({ objective: "Objective X" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    vi.mocked(client.crews.create).mockResolvedValue({
      crew: crew({ missionId: m.id }),
      members: [],
    });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await user.selectOptions(screen.getByLabelText("Mission"), m.id);
    await user.clear(screen.getByLabelText("Template name"));
    await user.type(screen.getByLabelText("Template name"), "duo");
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.click(screen.getByRole("checkbox", { name: "implementer" }));
    await waitFor(() => expect(screen.getByLabelText("Agent kind for implementer")).toBeTruthy());
    await user.selectOptions(screen.getByLabelText("Agent kind for implementer"), "shell");
    await user.clear(screen.getByLabelText("Max concurrent tasks"));
    await user.type(screen.getByLabelText("Max concurrent tasks"), "2");
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect(client.crews.create).toHaveBeenCalledWith({
      missionId: m.id,
      template: "duo",
      limits: { maxConcurrentTasks: 2 },
      members: [
        { role: "lead", agentKind: "shell" },
        { role: "implementer", agentKind: "shell" },
      ],
    });
    expect(await screen.findByText(/Created crew/)).toBeTruthy();
  });

  it("requires at least one role", async () => {
    const user = userEvent.setup();
    const m = mission();
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await user.selectOptions(screen.getByLabelText("Mission"), m.id);
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect(client.crews.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at least one role/i);
  });
});

describe("CrewDetail", () => {
  it("shows roster, active mission and live crew events", async () => {
    const m = mission({ objective: "Objective Y" });
    const c = crew({ missionId: m.id, template: "squad" });
    const ag = agent({ crewId: c.id, role: "reviewer" });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c], agents: [ag] })),
    });
    const { container } = renderWithStore(<CrewDetail />, {
      client,
      route: `/crews/${c.id}`,
      path: "/crews/:id",
    });
    expect(await screen.findByRole("heading", { level: 1, name: /squad/ })).toBeTruthy();
    const roster = screen.getByRole("region", { name: "Roster" });
    expect(within(roster).getByText("reviewer")).toBeTruthy();
    expect(
      within(roster).getByRole("link", { name: new RegExp(ag.runtimeSessionId as string) }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Objective Y" }).getAttribute("href")).toBe(
      `/missions/${m.id}`,
    );
    act(() =>
      client.streamController.push(
        event("task.ready", { from: "pending", to: "ready" }, { crewId: c.id }),
      ),
    );
    act(() =>
      client.streamController.push(
        event("task.failed", {
          from: "running",
          to: "failed",
          reason: "x",
          attempt: 1,
          retryable: false,
        }),
      ),
    );
    const live = screen.getByRole("region", { name: "Live events" });
    await waitFor(() => expect(within(live).getByText("task.ready")).toBeTruthy());
    expect(within(live).queryByText("task.failed")).toBeNull();
    await expectNoSeriousA11yViolations(container);
  });

  it("shows not found", async () => {
    renderWithStore(<CrewDetail />, {
      client: mockClient(),
      route: "/crews/crw_x",
      path: "/crews/:id",
    });
    expect(await screen.findByText(/Crew not found/)).toBeTruthy();
  });
});
