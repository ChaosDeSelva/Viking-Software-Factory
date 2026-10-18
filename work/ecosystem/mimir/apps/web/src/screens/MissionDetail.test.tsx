import { newId } from "@mimir/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { agent, crew, dependency, event, mission, snapshot, task } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { MissionDetail } from "./MissionDetail.js";

function setup() {
  const m = mission({ objective: "Build feature" });
  const c = crew({ missionId: m.id });
  const a = task({ missionId: m.id, crewId: c.id, title: "Alpha", status: "completed" });
  const b = task({ missionId: m.id, crewId: c.id, title: "Beta", status: "running" });
  const ag = agent({ crewId: c.id, taskId: b.id, role: "implementer" });
  const artifactId = newId("art");
  const history = [
    event(
      "task.started",
      { from: "leased", to: "running", agentId: ag.id, sessionId: ag.runtimeSessionId as never },
      { missionId: m.id, taskId: b.id, crewId: c.id },
    ),
    event(
      "test.run_completed",
      { command: "pnpm test", passed: false, total: 10, failed: 2, durationMs: 1200 },
      { missionId: m.id, taskId: a.id },
    ),
    event(
      "artifact.recorded",
      { artifactId, taskId: a.id, kind: "diff", uri: "file:///a.diff", hash: "sha256:abc" },
      { missionId: m.id, taskId: a.id },
    ),
    event(
      "summary.created",
      { scope: "mission", text: "Alpha done", sourceEventIds: [] },
      { missionId: m.id, provenance: "summarized" },
    ),
  ];
  const client = mockClient({
    snapshot: vi.fn(async () =>
      snapshot({
        missions: [m],
        crews: [c],
        tasks: [a, b],
        agents: [ag],
        taskDependencies: [dependency(b.id, a.id)],
      }),
    ),
  });
  vi.mocked(client.events.list).mockResolvedValue(page(history, null));
  vi.mocked(client.artifacts.get).mockResolvedValue({
    artifact: {
      id: artifactId,
      taskId: a.id,
      kind: "diff",
      uri: "file:///a.diff",
      hash: "sha256:abc",
      createdAt: "2026-10-14T10:00:00.000Z",
      updatedAt: "2026-10-14T10:00:00.000Z",
      version: 0,
    },
  });
  return { m, c, a, b, ag, client, artifactId };
}

function renderDetail(client: ReturnType<typeof mockClient>, id: string) {
  return renderWithStore(<MissionDetail />, {
    client,
    route: `/missions/${id}`,
    path: "/missions/:id",
  });
}

describe("MissionDetail", () => {
  it("shows header with completed/total progress and a Plan DAG", async () => {
    const { m, client } = setup();
    const { container } = renderDetail(client, m.id);
    expect(await screen.findByRole("heading", { level: 1, name: /Build feature/ })).toBeTruthy();
    expect(screen.getByText("1 of 2 tasks completed")).toBeTruthy();
    const svg = screen.getByRole("img", { name: /dependency graph/i });
    expect(within(svg as unknown as HTMLElement).getByText("Alpha")).toBeTruthy();
    expect(svg.querySelectorAll("line").length).toBe(1);
    await expectNoSeriousA11yViolations(container);
  });

  it("has keyboard-operable tabs", async () => {
    const user = userEvent.setup();
    const { m, client } = setup();
    renderDetail(client, m.id);
    const plan = await screen.findByRole("tab", { name: "Plan" });
    expect(plan.getAttribute("aria-selected")).toBe("true");
    plan.focus();
    await user.keyboard("{ArrowRight}");
    const timeline = screen.getByRole("tab", { name: "Timeline" });
    expect(timeline.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(timeline);
    expect(screen.getByRole("tabpanel", { name: "Timeline" })).toBeTruthy();
  });

  it("timeline shows history plus live events with provenance and filters", async () => {
    const user = userEvent.setup();
    const { m, a, client } = setup();
    renderDetail(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));
    const panel = screen.getByRole("tabpanel", { name: "Timeline" });
    const list = () => within(panel).getByRole("region", { name: "Events" });
    await waitFor(() => expect(within(list()).getByText("summary.created")).toBeTruthy());
    expect(client.events.list).toHaveBeenCalledWith(expect.objectContaining({ missionId: m.id }));
    expect(within(list()).getByText("summarized")).toBeTruthy();
    act(() =>
      client.streamController.push(
        event("task.ready", { from: "pending", to: "ready" }, { missionId: m.id, taskId: a.id }),
      ),
    );
    await waitFor(() => expect(within(list()).getByText("task.ready")).toBeTruthy());
    await user.selectOptions(within(panel).getByLabelText("Type"), "test.run_completed");
    expect(within(list()).queryByText("summary.created")).toBeNull();
    expect(within(list()).getByText("test.run_completed")).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText("Type"), "");
    await user.selectOptions(within(panel).getByLabelText("Task"), a.id);
    expect(within(list()).queryByText("task.started")).toBeNull();
    expect(within(list()).getByText("task.ready")).toBeTruthy();
  });

  it("agents tab links to the inspector", async () => {
    const user = userEvent.setup();
    const { m, ag, client } = setup();
    renderDetail(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Agents" }));
    const link = screen.getByRole("link", { name: new RegExp(ag.runtimeSessionId as string) });
    expect(link.getAttribute("href")).toBe(`/agents/${ag.runtimeSessionId}`);
  });

  it("tests, files and artifacts tabs show recorded evidence", async () => {
    const user = userEvent.setup();
    const { m, client, artifactId } = setup();
    renderDetail(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Tests" }));
    await waitFor(() => expect(screen.getByText("pnpm test")).toBeTruthy());
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 of 10 failed/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Files" }));
    await user.click(screen.getByRole("button", { name: `View ${artifactId}` }));
    expect(client.artifacts.get).toHaveBeenCalledWith(artifactId);
    expect(await screen.findByText("sha256:abc")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(screen.getByText(artifactId)).toBeTruthy();
  });

  it("costs tab shows mission usage with source chips", async () => {
    const user = userEvent.setup();
    const { m, client } = setup();
    vi.mocked(client.usage.get).mockResolvedValue({
      totals: {
        tokens: 5,
        estimatedCost: 0,
        samples: 3,
        bySource: { measured: 0, estimated: 0, unavailable: 3 },
      },
      samples: [],
    });
    renderDetail(client, m.id);
    await user.click(await screen.findByRole("tab", { name: "Costs" }));
    expect(await screen.findByText("unavailable: 3")).toBeTruthy();
    expect(client.usage.get).toHaveBeenCalledWith({ missionId: m.id });
  });

  it("shows not found for an unknown mission", async () => {
    const { client } = setup();
    renderDetail(client, newId("msn"));
    expect(await screen.findByText(/Mission not found/)).toBeTruthy();
  });
});
