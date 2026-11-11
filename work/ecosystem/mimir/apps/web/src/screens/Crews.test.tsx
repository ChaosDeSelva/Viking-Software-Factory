import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { agent, crew, event, mission, project, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { CrewDetail, Crews } from "./Crews.js";

/** The create form lives in the "New crew" dialog. */
export async function openForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "New crew" })[0]!);
  await screen.findByRole("dialog", { name: "New crew" });
}

/** Mission is a searchable Combobox: open it, click the option. */
export async function pickMission(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByLabelText("Mission"));
  await user.click(await screen.findByRole("option", { name }));
}

describe("Crews", () => {
  it("lists crews with their mission and limits", async () => {
    const m = mission({ objective: "Objective X" });
    const c = crew({ missionId: m.id, template: "squad", limits: { maxConcurrentTasks: 3 } });
    const { container } = renderWithStore(<Crews />, {
      client: mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c] })) }),
    });
    const link = await screen.findByRole("link", { name: "Squad crew" });
    expect(link.getAttribute("href")).toBe(`/crews/${c.id}`);
    expect(screen.getByRole("link", { name: "Objective X" }).getAttribute("href")).toBe(
      `/missions/${m.id}`,
    );
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
    await openForm(user);
    await pickMission(user, "Objective X");
    await user.clear(screen.getByLabelText("Template name"));
    await user.type(screen.getByLabelText("Template name"), "duo");
    await user.click(screen.getByRole("checkbox", { name: "lead" }));
    await user.click(screen.getByRole("checkbox", { name: "implementer" }));
    await waitFor(() => expect(screen.getByLabelText("Agent kind for implementer")).toBeTruthy());
    await user.click(screen.getByRole("combobox", { name: "Agent kind for implementer" }));
    await user.click(await screen.findByRole("option", { name: "shell" }));
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
    const m = mission({ objective: "Objective Z" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderWithStore(<Crews />, { client });
    await screen.findByText(/No crews yet/);
    await openForm(user);
    await pickMission(user, "Objective Z");
    await user.click(screen.getByRole("button", { name: "Create crew" }));
    expect(client.crews.create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/at least one role/i);
  });
});

describe("CrewDetail", () => {
  it("offers Raise budget, as the primary action when a crew task is budget-blocked", async () => {
    const m = mission({ objective: "Objective Z" });
    const c = crew({ missionId: m.id, template: "squad" });
    const t = task({
      missionId: m.id,
      crewId: c.id,
      status: "blocked",
      blockedReason: "budget_exceeded",
    });
    renderWithStore(<CrewDetail />, {
      client: mockClient({
        snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c], tasks: [t] })),
      }),
      route: `/crews/${c.id}`,
      path: "/crews/:id",
    });
    const user = userEvent.setup();
    const raise = await screen.findByRole("button", { name: "Raise budget" });
    expect(raise.className).toMatch(/bg-accent/);
    await user.click(raise);
    expect(await screen.findByRole("dialog", { name: "Raise budget" })).toBeTruthy();
  });

  it("offers no Raise budget once the crew's mission has ended (the server refuses it)", async () => {
    const m = mission({ status: "completed" });
    const c = crew({ missionId: m.id, template: "squad" });
    renderWithStore(<CrewDetail />, {
      client: mockClient({
        snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c] })),
      }),
      route: `/crews/${c.id}`,
      path: "/crews/:id",
    });
    expect(await screen.findByRole("heading", { level: 1, name: /Squad crew/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raise budget" })).toBeNull();
  });

  it("names the crew's own project in the breadcrumb, not the selected one", async () => {
    const p1 = project({ name: "alpha" });
    const p2 = project({ name: "beta" });
    const m2 = mission({ projectId: p2.id });
    const c = crew({ missionId: m2.id, template: "squad" });
    localStorage.setItem("mimir.project", p1.id);
    renderWithStore(<CrewDetail />, {
      client: mockClient({
        snapshot: vi.fn(async () =>
          snapshot({
            projects: [p1, p2],
            missions: [mission({ projectId: p1.id }), m2],
            crews: [c],
          }),
        ),
      }),
      route: `/crews/${c.id}`,
      path: "/crews/:id",
    });
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(within(crumbs).getByText("beta")).toBeTruthy());
    expect(within(crumbs).queryByText("alpha")).toBeNull();
  });

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
    expect(await screen.findByRole("heading", { level: 1, name: /Squad crew/ })).toBeTruthy();
    const roster = screen.getByRole("region", { name: /Roster/ });
    expect(within(roster).getByText("reviewer")).toBeTruthy();
    expect(
      within(roster)
        .getByRole("link", { name: `Live output ${ag.runtimeSessionId}` })
        .getAttribute("href"),
    ).toBe(`/agents/${ag.runtimeSessionId}?follow=1`);
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

  it("explains that live events only cover this page visit and links to Activity", async () => {
    const c = crew();
    renderWithStore(<CrewDetail />, {
      client: mockClient({ snapshot: vi.fn(async () => snapshot({ crews: [c] })) }),
      route: `/crews/${c.id}`,
      path: "/crews/:id",
    });
    const live = await screen.findByRole("region", { name: "Live events" });
    expect(within(live).getByText(/since this page loaded/)).toBeTruthy();
    expect(within(live).getByRole("link", { name: "Open Activity" }).getAttribute("href")).toBe(
      "/activity",
    );
  });
});

describe("Crews: status and project scope", () => {
  it("hides crews of ended missions under Active and shows them with the mission's state under All", async () => {
    const user = userEvent.setup();
    const live = mission({ objective: "Live mission" });
    const done = mission({ objective: "Done mission", status: "completed" });
    const a = crew({ missionId: live.id, template: "implementer", status: "configured" });
    const b = crew({ missionId: done.id, template: "reviewer", status: "configured" });
    const working = agent({ crewId: a.id, status: "running" });
    renderWithStore(<Crews />, {
      client: mockClient({
        snapshot: vi.fn(async () =>
          snapshot({ missions: [live, done], crews: [a, b], agents: [working] }),
        ),
      }),
    });
    const row = (await screen.findByRole("link", { name: "Implementer crew" })).closest("tr")!;
    // Stored `configured`, but an agent works now: shown as running.
    expect(
      within(row)
        .getByRole("img", { name: /Status: / })
        .getAttribute("aria-label"),
    ).toMatch(/running|working/i);
    expect(screen.queryByRole("link", { name: "Reviewer crew" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "All" }));
    const ended = (await screen.findByRole("link", { name: "Reviewer crew" })).closest("tr")!;
    expect(
      within(ended)
        .getByRole("img", { name: /Status: / })
        .getAttribute("aria-label"),
    ).toMatch(/complete/i);
  });

  it("lists only the selected project's crews and offers only its missions", async () => {
    const user = userEvent.setup();
    const p1 = project({ name: "alpha" });
    const p2 = project({ name: "beta" });
    const m1 = mission({ projectId: p1.id, objective: "Alpha mission" });
    const m2 = mission({ projectId: p2.id, objective: "Beta mission" });
    const c1 = crew({ missionId: m1.id, template: "alpha-team" });
    const c2 = crew({ missionId: m2.id, template: "beta-team" });
    localStorage.setItem("mimir.project", p1.id);
    renderWithStore(<Crews />, {
      client: mockClient({
        snapshot: vi.fn(async () =>
          snapshot({ projects: [p1, p2], missions: [m1, m2], crews: [c1, c2] }),
        ),
      }),
    });
    expect(await screen.findByRole("link", { name: "Alpha team crew" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Beta team crew" })).toBeNull();
    await openForm(user);
    await user.click(screen.getByLabelText("Mission"));
    expect(await screen.findByRole("option", { name: "Alpha mission" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Beta mission" })).toBeNull();
  });
});
