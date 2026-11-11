import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { agent, mission, project, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Missions } from "./Missions.js";

describe("Missions", () => {
  it("lists missions with task-count progress and a board of task columns", async () => {
    const p = project({ name: "alpha" });
    const m = mission({ projectId: p.id, objective: "Add login", status: "active" });
    const tasks = [
      task({ missionId: m.id, title: "T-pending", status: "pending" }),
      task({ missionId: m.id, title: "T-leased", status: "leased" }),
      task({ missionId: m.id, title: "T-done", status: "completed" }),
      task({ missionId: m.id, title: "T-cancelled", status: "cancelled" }),
    ];
    const { container } = renderWithStore(<Missions />, {
      client: mockClient({
        snapshot: vi.fn(async () => snapshot({ projects: [p], missions: [m], tasks })),
      }),
    });
    const table = await screen.findByRole("table", { name: "Missions" });
    const link = within(table).getByRole("link", { name: "Add login" });
    expect(link.getAttribute("href")).toBe(`/missions/${m.id}`);
    expect(within(table).getByText("1 of 4 tasks completed")).toBeTruthy();
    expect(within(table).getByRole("img", { name: "Status: Active" })).toBeTruthy();

    const board = screen.getByRole("region", { name: "Task board" });
    const columns = within(board).getAllByRole("list");
    expect(columns).toHaveLength(7);
    const running = within(board).getByRole("list", { name: "Running" });
    expect(within(running).getByText("T-leased")).toBeTruthy();
    const failed = within(board).getByRole("list", { name: "Failed / cancelled" });
    expect(within(failed).getByText("T-cancelled")).toBeTruthy();
    // Cards are compact: the prompt stays behind its disclosure until opened.
    expect(within(board).getAllByText("Prompt")).toHaveLength(4);
    expect(container.textContent).not.toMatch(/\d+%/);
    await expectNoSeriousA11yViolations(container);
  });

  it("filters the board by mission", async () => {
    const user = userEvent.setup();
    const a = mission({ objective: "A" });
    const b = mission({ objective: "B" });
    renderWithStore(<Missions />, {
      client: mockClient({
        snapshot: vi.fn(async () =>
          snapshot({
            missions: [a, b],
            tasks: [task({ missionId: a.id, title: "ta" }), task({ missionId: b.id, title: "tb" })],
          }),
        ),
      }),
    });
    const board = await screen.findByRole("region", { name: "Task board" });
    await within(board).findByText("ta");
    await user.click(within(board).getByRole("button", { name: /Mission filter/ }));
    await user.click(await screen.findByRole("option", { name: "B" }));
    expect(within(board).queryByText("ta")).toBeNull();
    expect(within(board).getByText("tb")).toBeTruthy();
  });

  it("creates a mission for a project", async () => {
    const user = userEvent.setup();
    const p = project({ name: "alpha" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ projects: [p] })) });
    vi.mocked(client.missions.create).mockResolvedValue({
      mission: mission({ objective: "Ship" }),
    });
    renderWithStore(<Missions />, { client });
    await screen.findByText(/No missions yet/);
    await user.click(screen.getAllByRole("button", { name: "New mission" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New mission" });
    // The only project is the selected scope, so it is preselected.
    expect(within(dialog).getByRole("button", { name: /Project/ }).textContent).toMatch("alpha");
    await user.type(within(dialog).getByLabelText(/Objective/), "Ship");
    await user.click(within(dialog).getByRole("button", { name: "Create mission" }));
    expect(client.missions.create).toHaveBeenCalledWith({ projectId: p.id, objective: "Ship" });
    expect(await within(dialog).findByText(/Created mission/)).toBeTruthy();
  });

  it("starts a draft mission and shows the operation id", async () => {
    const user = userEvent.setup();
    const m = mission({ status: "draft", objective: "Draft one" });
    const client = mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m] })) });
    renderWithStore(<Missions />, { client });
    await user.click(await screen.findByRole("button", { name: "Start Draft one" }));
    expect(client.missions.start).toHaveBeenCalledWith(m.id, {});
    await waitFor(() => expect(screen.getByText(/operation/)).toBeTruthy());
  });

  it("shows an empty state with a next action", async () => {
    renderWithStore(<Missions />, { client: mockClient() });
    expect(await screen.findByText(/No missions yet/)).toBeTruthy();
    // Header action plus the empty state's own.
    expect(screen.getAllByRole("button", { name: "New mission" })).toHaveLength(2);
  });

  it("names Sindri-generated missions by their first task and caps board columns", async () => {
    const user = userEvent.setup();
    const m = mission({
      objective: "Sindri plan 1e7d7af5-b32a-423f-90a0-dd74b6d30daf v1 (spec ab02cdd3-0ea9 v1)",
    });
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task({
        missionId: m.id,
        status: "completed",
        title: `step-${i}: Do part ${i} of the work. Then check it twice.`,
        createdAt: `2026-10-14T10:00:0${i}.000Z`,
      }),
    );
    renderWithStore(<Missions />, {
      client: mockClient({ snapshot: vi.fn(async () => snapshot({ missions: [m], tasks })) }),
    });
    const table = await screen.findByRole("table", { name: "Missions" });
    expect(within(table).getByRole("link", { name: "Do part 0 of the work" })).toBeTruthy();
    expect(within(table).getByText("Sindri plan 1e7d7af5 v1")).toBeTruthy();
    const done = screen.getByRole("list", { name: "Completed" });
    expect(within(done).getAllByRole("listitem")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(within(done).getAllByRole("listitem")).toHaveLength(8);
  });

  it("links a running task's card to its live output", async () => {
    const m = mission();
    const t = task({ missionId: m.id, status: "running", title: "build: Compile it" });
    const ag = agent({ taskId: t.id, status: "running" });
    renderWithStore(<Missions />, {
      client: mockClient({
        snapshot: vi.fn(async () => snapshot({ missions: [m], tasks: [t], agents: [ag] })),
      }),
    });
    const link = await screen.findByRole("link", { name: "Live output of build · Compile it" });
    expect(link.getAttribute("href")).toBe(`/agents/${ag.runtimeSessionId}?follow=1`);
  });
});
