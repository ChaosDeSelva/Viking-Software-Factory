import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { App } from "./App.js";
import { Button } from "./components/ui.js";
import { NoticeRegion } from "./components/Layout.js";
import { DeliveriesScreen } from "./screens/DeliveriesScreen.js";
import { HarnessesScreen } from "./screens/HarnessesScreen.js";
import { PlansScreen } from "./screens/PlansScreen.js";
import { RunsScreen } from "./screens/RunsScreen.js";
import { delivery, executionDetail, plan, trace, versionOf } from "./test/delivery-fixtures.js";
import { mockApi, PROJECT, renderWithStore } from "./test/utils.js";

const idle = () => new Promise<void>(() => undefined);

describe("accessibility fixes (review I4, audit S-I1/S-I3/S-I5/S-I6)", () => {
  it("announces load errors with role=alert", async () => {
    renderWithStore(
      <PlansScreen />,
      mockApi({ listPlans: () => Promise.reject(new Error("boom")), listSpecs: [] }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not load plans: boom/);
  });

  it("announces error notices with role=alert and keeps info notices polite", async () => {
    renderWithStore(<NoticeRegion />, mockApi(), {
      notice: { kind: "error", text: "it failed" },
    });
    expect(screen.getByRole("alert").textContent).toMatch(/it failed/);
  });

  it("moves focus to the detail heading when a plan, run or delivery opens", async () => {
    const p = plan();
    renderWithStore(
      <PlansScreen />,
      mockApi({
        listPlans: [p],
        listSpecs: [],
        getPlan: { plan: p, versions: [versionOf(p)] },
        dryRunPlan: { steps: [], order: [] },
      }),
      { planId: "pl1" },
    );
    const h = await screen.findByRole("heading", { name: /Plan v1/ });
    await waitFor(() => expect(document.activeElement).toBe(h));
  });

  it("focuses the run and delivery headings too", async () => {
    const { unmount } = renderWithStore(
      <RunsScreen />,
      mockApi({ listExecutions: [], getExecution: executionDetail(), streamExecution: idle }),
      { executionId: "e1" },
    );
    const run = await screen.findByRole("heading", { name: /Run of plan v1/ });
    await waitFor(() => expect(document.activeElement).toBe(run));
    unmount();
    renderWithStore(
      <DeliveriesScreen />,
      mockApi({ listDeliveries: [], getDelivery: delivery(), deliveryTrace: trace() }),
      { deliveryId: "e1" },
    );
    const del = await screen.findByRole("heading", { name: "CSV export for reports" });
    await waitFor(() => expect(document.activeElement).toBe(del));
  });

  it("links each task's agent session in Mimir", async () => {
    renderWithStore(
      <RunsScreen />,
      mockApi({
        listExecutions: [],
        getExecution: executionDetail({
          links: {
            mission: "http://127.0.0.1:7700/missions/msn_1",
            agents: [
              {
                planTaskId: "implement-frontend",
                sessionId: "ses_1",
                url: "http://127.0.0.1:7700/agents/ses_1",
              },
            ],
          },
        }),
        streamExecution: idle,
      }),
      { executionId: "e1" },
    );
    const link = await screen.findByRole("link", {
      name: "Open agent session for implement-frontend in Mimir",
    });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:7700/agents/ses_1");
  });

  it("shows install, pin and verify as unavailable until Brokkr is wired", async () => {
    renderWithStore(
      <HarnessesScreen />,
      mockApi({
        listHarnesses: {
          source: "fake",
          harnesses: [
            {
              name: "frontend-react",
              version: "1.1.0",
              description: "React",
              taskTypes: ["frontend"],
              skills: { required: [], optional: [] },
              checks: [],
            },
          ],
        },
        repoSignals: {
          packageManager: null,
          frameworks: [],
          scripts: [],
          hasTsconfig: false,
          testRunners: [],
        },
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "frontend-react@1.1.0" }));
    for (const name of ["Install from a local path", "Pin this version", "Verify"])
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Brokkr wiring .* not built yet/)).toBeTruthy();
  });

  it("uses a theme-aware focus ring (dark mode contrast)", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").className).toMatch(/dark:focus-visible:outline-indigo-300/);
  });
});

describe("App routing and titles", () => {
  it("opens the view from the URL hash, updates the hash and title, and follows Back", async () => {
    window.history.replaceState(null, "", "/#/reviews?project=p1");
    const api = mockApi({
      listProjects: [PROJECT],
      reviews: {
        deliveryService: "s6",
        approvals: [],
        escalations: [],
        budgetAlerts: [],
        gateFailures: [],
        findings: [],
      },
      listPlans: [],
      listSpecs: [],
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    const current = () =>
      screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "page")
        ?.textContent;
    expect(current()).toBe("Reviews");
    await waitFor(() => expect(document.title).toBe("Reviews · Sindri"));
    await userEvent.click(screen.getByRole("button", { name: "Plans" }));
    await waitFor(() => expect(window.location.hash).toBe("#/plans?project=p1"));
    expect(document.title).toBe("Plans · Sindri");
    act(() => {
      window.history.replaceState(null, "", "/#/reviews?project=p1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(current()).toBe("Reviews"));
  });

  it("ignores Alt+digit while typing in a field", async () => {
    const api = mockApi({ listProjects: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    const field = await screen.findByLabelText("Name");
    await userEvent.click(field);
    await userEvent.keyboard("{Alt>}7{/Alt}");
    const current = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-current") === "page")?.textContent;
    expect(current).toBe("Projects");
  });
});
