import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { mission, project, snapshot, task } from "../test/fixtures.js";
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
    const link = await screen.findByRole("link", { name: "Add login" });
    expect(link.getAttribute("href")).toBe(`/missions/${m.id}`);
    expect(screen.getByText("1 of 4 tasks completed")).toBeTruthy();

    const board = screen.getByRole("region", { name: "Task board" });
    const columns = within(board).getAllByRole("list");
    expect(columns).toHaveLength(7);
    const running = within(board).getByRole("list", { name: "Running" });
    expect(within(running).getByText("T-leased")).toBeTruthy();
    const failed = within(board).getByRole("list", { name: "Failed / cancelled" });
    expect(within(failed).getByText("T-cancelled")).toBeTruthy();
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
    await screen.findByText("ta");
    await user.selectOptions(screen.getByLabelText("Mission filter"), b.id);
    expect(screen.queryByText("ta")).toBeNull();
    expect(screen.getByText("tb")).toBeTruthy();
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
    await user.selectOptions(screen.getByLabelText("Project"), p.id);
    await user.type(screen.getByLabelText("Objective"), "Ship");
    await user.click(screen.getByRole("button", { name: "Create mission" }));
    expect(client.missions.create).toHaveBeenCalledWith({ projectId: p.id, objective: "Ship" });
    expect(await screen.findByText(/Created mission/)).toBeTruthy();
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

  it("shows an empty state", async () => {
    renderWithStore(<Missions />, { client: mockClient() });
    expect(await screen.findByText(/No missions yet/)).toBeTruthy();
  });
});
