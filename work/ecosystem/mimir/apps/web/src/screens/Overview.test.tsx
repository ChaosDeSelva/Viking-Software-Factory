import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { approval, crew, event, mission, project, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Overview } from "./Overview.js";

describe("Overview", () => {
  it("shows loading, then Needs attention first, fleet health, crews, events and usage", async () => {
    const m = mission({ objective: "Refactor auth" });
    const c = crew({ missionId: m.id, template: "pair" });
    const blocked = task({
      missionId: m.id,
      status: "blocked",
      title: "Write tests",
      blockedReason: "policy",
    });
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({
          missions: [m],
          crews: [c],
          tasks: [blocked],
          approvals: [approval({ action: "runtime.force_stop" })],
          usage: {
            tokens: 10,
            estimatedCost: 0,
            samples: 2,
            bySource: { measured: 1, estimated: 0, unavailable: 1 },
          },
        }),
      ),
    });
    const { container } = renderWithStore(<Overview />, { client });
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);

    const attention = await screen.findByRole("region", { name: /Needs attention/ });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Needs attention/);
    expect(within(attention).getByText(/Approval needed: runtime.force_stop/)).toBeTruthy();
    expect(within(attention).getByText(/Blocked: Write tests/)).toBeTruthy();
    expect(
      within(attention)
        .getByRole("link", { name: /Approval needed: runtime.force_stop/ })
        .getAttribute("href"),
    ).toBe("/reviews");
    expect(screen.getByRole("link", { name: "Pending approvals" }).getAttribute("href")).toBe(
      "/reviews",
    );

    const fleet = screen.getByRole("region", { name: "Fleet health" });
    await waitFor(() => expect(within(fleet).getByText(/fake/)).toBeTruthy());
    expect(within(fleet).getByRole("img", { name: /^Status: / })).toBeTruthy();

    const crews = screen.getByRole("region", { name: /Active crews/ });
    // Human name: crew template plus the mission's name, never the raw ids.
    expect(within(crews).getByRole("link", { name: /Pair crew · Refactor auth/ })).toBeTruthy();
    expect(within(crews).getByText(/0 of 1 tasks completed/)).toBeTruthy();

    expect(screen.getByText("measured: 1")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d+%/);
    await expectNoSeriousA11yViolations(container);
  });

  it("shows live events in the recent events ticker with provenance", async () => {
    const client = mockClient();
    renderWithStore(<Overview />, { client });
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() =>
      client.streamController.push(
        event(
          "summary.created",
          { scope: "mission", text: "Half done", sourceEventIds: [] },
          { provenance: "summarized" },
        ),
      ),
    );
    const recent = await screen.findByRole("region", { name: "Recent events" });
    await waitFor(() => expect(within(recent).getByText("summary.created")).toBeTruthy());
    expect(within(recent).getByText("summarized")).toBeTruthy();
  });

  it("shows empty states", async () => {
    renderWithStore(<Overview />, { client: mockClient() });
    expect(await screen.findByText(/Nothing needs attention/)).toBeTruthy();
    expect(screen.getByText(/No active crews/)).toBeTruthy();
    expect(screen.getByText(/No events since this page opened/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Replay history in Activity" }).getAttribute("href"),
    ).toBe("/activity");
    expect(screen.getByRole("link", { name: "Open missions" })).toBeTruthy();
  });

  it("shows an error with retry when the snapshot fails", async () => {
    const client = mockClient({
      snapshot: vi.fn(async () => Promise.reject(new Error("offline"))),
    });
    renderWithStore(<Overview />, { client });
    expect((await screen.findByRole("alert")).textContent).toMatch(/offline/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Overview (project scope and real crew status)", () => {
  it("lists only crews whose mission can still run, with the mission's end state elsewhere", async () => {
    const live = mission({ objective: "Ship farewell" });
    const done = mission({ objective: "Old work", status: "completed" });
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({
          missions: [live, done],
          crews: [
            crew({ missionId: live.id, template: "implementer", status: "configured" }),
            crew({ missionId: done.id, template: "reviewer", status: "configured" }),
          ],
        }),
      ),
    });
    renderWithStore(<Overview />, { client });
    const crews = await screen.findByRole("region", { name: /Active crews/ });
    expect(
      within(crews).getByRole("link", { name: /Implementer crew · Ship farewell/ }),
    ).toBeTruthy();
    expect(within(crews).queryByText(/Old work/)).toBeNull();
  });

  it("names Sindri-generated missions from their first task, not the plan ids", async () => {
    const m = mission({
      objective:
        "Sindri plan 1e7d7af5-b32a-423f-90a0-dd74b6d30daf v1 (spec ab02cdd3-0ea9-4f93-91da-5a511d65ab15 v1)",
    });
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({
          missions: [m],
          crews: [crew({ missionId: m.id, template: "implementer" })],
          tasks: [
            task({
              missionId: m.id,
              title:
                "implement-backend: Add a GET /farewell route to the greeter. It reads the name.",
            }),
          ],
        }),
      ),
    });
    renderWithStore(<Overview />, { client });
    const crews = await screen.findByRole("region", { name: /Active crews/ });
    expect(
      within(crews).getByRole("link", {
        name: /Implementer crew · Add a GET \/farewell route to the greeter/,
      }),
    ).toBeTruthy();
    expect(crews.textContent).not.toMatch(/1e7d7af5-b32a/);
  });

  it("asks the server for the selected project's usage", async () => {
    const p = project({ name: "alpha" });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ projects: [p] })),
    });
    renderWithStore(<Overview />, { client });
    await screen.findByRole("region", { name: "Usage" });
    // A single project is selected by default, so usage comes from the scoped endpoint.
    await waitFor(() => expect(client.usage.get).toHaveBeenCalledWith({ projectId: p.id }));
  });
});
