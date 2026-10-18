import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { approval, crew, event, mission, snapshot, task } from "../test/fixtures.js";
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

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe("Needs attention");
    expect(within(attention).getByText(/Approval needed: runtime.force_stop/)).toBeTruthy();
    expect(within(attention).getByText(/Blocked: Write tests/)).toBeTruthy();
    expect(
      within(attention)
        .getByRole("link", { name: /Review/ })
        .getAttribute("href"),
    ).toBe("/reviews");

    const fleet = screen.getByRole("region", { name: "Fleet health" });
    await waitFor(() => expect(within(fleet).getByText(/fake/)).toBeTruthy());
    expect(within(fleet).getByText("ok")).toBeTruthy();

    const crews = screen.getByRole("region", { name: "Active crews" });
    expect(within(crews).getByRole("link", { name: /pair/ })).toBeTruthy();
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
    expect(screen.getByText(/No events yet/)).toBeTruthy();
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
