import type { BudgetPolicy } from "@mimir/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MissionDetail } from "../screens/MissionDetail.js";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { crew, event, mission, snapshot, task } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";

const policy = (over: Partial<BudgetPolicy>): BudgetPolicy => ({
  id: "bgt_1" as BudgetPolicy["id"],
  missionId: null,
  crewId: null,
  limitTokens: 100_000,
  limitCost: null,
  warnAtFraction: 0.8,
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  version: 2,
  ...over,
});

function usage(tokens: number) {
  return {
    totals: {
      tokens,
      estimatedCost: 0.5,
      samples: 3,
      bySource: { measured: 3, estimated: 0, unavailable: 0 },
    },
    samples: [],
  };
}

/** A mission whose crew ran out of tokens; `missionScope` makes the mission budget the one. */
function setup({
  missionScope = false,
  blocked = true,
  reason = "budget_exceeded",
  crewBudget = true,
}: {
  missionScope?: boolean;
  blocked?: boolean;
  reason?: "budget_exceeded" | "budget_uncertain";
  crewBudget?: boolean;
} = {}) {
  const m = mission({ objective: "Ship it" });
  const c = crew({ missionId: m.id, template: "implementer" });
  const t = task({
    missionId: m.id,
    title: "build: Compile the thing",
    status: blocked ? "blocked" : "ready",
    ...(blocked ? { blockedReason: reason } : {}),
  });
  const history = [
    event(
      "crew.created",
      {
        crew: c,
        members: [],
        ...(crewBudget ? { budget: policy({ crewId: c.id, missionId: m.id, version: 0 }) } : {}),
      },
      { missionId: m.id, crewId: c.id },
    ),
    ...(crewBudget
      ? [
          event(
            "budget.updated",
            { budget: policy({ crewId: c.id, missionId: m.id }), previous: null },
            { missionId: m.id, crewId: c.id },
          ),
        ]
      : []),
    ...(missionScope
      ? [
          event(
            "mission.created",
            {
              projectId: m.projectId,
              objective: m.objective,
              budget: policy({ missionId: m.id, limitTokens: 50_000, version: 5 }),
            },
            { missionId: m.id },
          ),
        ]
      : []),
    ...(reason === "budget_uncertain"
      ? []
      : [
          event(
            "budget.exceeded",
            {
              budgetId: "bgt_1" as never,
              unit: "tokens",
              used: 120_000,
              limit: 100_000,
              ...(missionScope ? { scope: "mission" as const } : {}),
            },
            { missionId: m.id, ...(missionScope ? {} : { crewId: c.id }) },
          ),
        ]),
  ];
  const client = mockClient({
    snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c], tasks: [t] })),
  });
  vi.mocked(client.events.list).mockResolvedValue(page(history, null));
  vi.mocked(client.usage.get).mockResolvedValue(usage(120_000));
  vi.mocked(client.crews.updateBudget).mockResolvedValue({
    budget: policy({ crewId: c.id, limitTokens: 180_000, version: 3 }),
    changed: true,
  });
  vi.mocked(client.missions.updateBudget).mockResolvedValue({
    budget: policy({ missionId: m.id, limitTokens: 180_000, version: 6 }),
    changed: true,
  });
  const view = renderWithStore(<MissionDetail />, {
    client,
    route: `/missions/${m.id}`,
    path: "/missions/:id",
  });
  return { m, c, t, client, ...view };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Raise budget for build/ }));
  return screen.findByRole("dialog", { name: "Raise budget" });
}

describe("Raise budget", () => {
  it("is offered only for tasks blocked by a budget", async () => {
    setup({ blocked: false });
    await screen.findByRole("table", { name: "Tasks" });
    expect(screen.queryByRole("button", { name: /Raise budget/ })).toBeNull();
  });

  it("shows a callout and the current numbers with a suggested new limit", async () => {
    const user = userEvent.setup();
    const { c, client } = setup();
    expect(await screen.findByText(/1 task is blocked: budget exceeded/)).toBeTruthy();
    const dialog = await openDialog(user);
    await within(dialog).findByText("120,000");
    expect(client.usage.get).toHaveBeenCalledWith({ crewId: c.id });
    expect(client.events.list).toHaveBeenCalledWith(
      expect.objectContaining({ types: expect.arrayContaining(["budget.exceeded"]) }),
    );
    expect(within(dialog).getByText("100,000")).toBeTruthy();
    expect(within(dialog).getByText("Implementer crew")).toBeTruthy();
    const input = within(dialog).getByLabelText(/New token limit/) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await expectNoSeriousA11yViolations(dialog);
  });

  it("raises the crew budget with the version it read, then closes", async () => {
    const user = userEvent.setup();
    const { c, client } = setup();
    const dialog = await openDialog(user);
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await user.clear(input);
    await user.type(input, "250000");
    await user.click(within(dialog).getByRole("button", { name: "Raise budget" }));
    expect(client.crews.updateBudget).toHaveBeenCalledWith(c.id, {
      limitTokens: 250_000,
      expectedVersion: 2,
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Raise budget" })).toBeNull());
    expect(await screen.findByText("Budget raised")).toBeTruthy();
  });

  it("refuses a limit that does not raise anything", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const dialog = await openDialog(user);
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await user.clear(input);
    await user.type(input, "90000");
    await user.click(within(dialog).getByRole("button", { name: "Raise budget" }));
    expect(within(dialog).getByText(/above the current 100,000 tokens/)).toBeTruthy();
    expect(client.crews.updateBudget).not.toHaveBeenCalled();
  });

  it("explains a version conflict and reloads the numbers", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    vi.mocked(client.crews.updateBudget).mockRejectedValueOnce(
      Object.assign(new Error("budget version changed"), { name: "MimirError", code: "conflict" }),
    );
    const dialog = await openDialog(user);
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await user.click(within(dialog).getByRole("button", { name: "Raise budget" }));
    expect(await within(dialog).findByText(/budget changed since you opened this/i)).toBeTruthy();
    const loads = vi.mocked(client.events.list).mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Reload the numbers" }));
    await waitFor(() => expect(vi.mocked(client.events.list).mock.calls.length).toBe(loads + 1));
  });

  it("raises the mission budget when that is the one exhausted", async () => {
    const user = userEvent.setup();
    const { m, client } = setup({ missionScope: true });
    const dialog = await openDialog(user);
    await within(dialog).findByText("Mission budget", { selector: "dd" });
    expect(client.usage.get).toHaveBeenCalledWith({ missionId: m.id });
    expect(within(dialog).getByText("50,000")).toBeTruthy();
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await user.click(within(dialog).getByRole("button", { name: "Raise budget" }));
    expect(client.missions.updateBudget).toHaveBeenCalledWith(m.id, {
      limitTokens: 180_000,
      expectedVersion: 5,
    });
    expect(client.crews.updateBudget).not.toHaveBeenCalled();
  });

  it("clears an unknown-usage block by allowing unknown usage, keeping the limit", async () => {
    const user = userEvent.setup();
    const { c, client } = setup({ reason: "budget_uncertain" });
    expect(await screen.findByText(/1 task is blocked: budget usage unknown/)).toBeTruthy();
    const dialog = await openDialog(user);
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await within(dialog).findByText("120,000");
    expect(input.value).toBe("");
    const allow = within(dialog).getByRole("radio", { name: "Allow new work" });
    expect(allow.getAttribute("aria-checked")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(client.crews.updateBudget).toHaveBeenCalledWith(c.id, {
      onUnknown: "allow",
      expectedVersion: 2,
    });
    expect(await screen.findByText("Budget saved")).toBeTruthy();
  });

  it("preselects the budget whose unknown-usage rule blocks, for an unknown-usage block", async () => {
    const user = userEvent.setup();
    const m = mission({ objective: "Ship it" });
    const c = crew({ missionId: m.id, template: "implementer" });
    const t = task({
      missionId: m.id,
      crewId: c.id,
      title: "build: Compile the thing",
      status: "blocked",
      blockedReason: "budget_uncertain",
    });
    const history = [
      event(
        "mission.created",
        {
          projectId: m.projectId,
          objective: m.objective,
          budget: policy({ id: "bgt_m" as never, missionId: m.id, onUnknown: "block", version: 0 }),
        },
        { missionId: m.id },
      ),
      event(
        "crew.created",
        {
          crew: c,
          members: [],
          budget: policy({ crewId: c.id, missionId: m.id, onUnknown: "allow", version: 0 }),
        },
        { missionId: m.id, crewId: c.id },
      ),
    ];
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ missions: [m], crews: [c], tasks: [t] })),
    });
    vi.mocked(client.events.list).mockResolvedValue(page(history, null));
    vi.mocked(client.usage.get).mockResolvedValue(usage(120_000));
    vi.mocked(client.missions.updateBudget).mockResolvedValue({
      budget: policy({ missionId: m.id, onUnknown: "allow", version: 1 }),
      changed: true,
    });
    renderWithStore(<MissionDetail />, {
      client,
      route: `/missions/${m.id}`,
      path: "/missions/:id",
    });
    const dialog = await openDialog(user);
    await within(dialog).findByText("Mission budget", { selector: "dd" });
    await within(dialog).findByText("120,000");
    await user.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(client.missions.updateBudget).toHaveBeenCalledWith(m.id, {
      onUnknown: "allow",
      expectedVersion: 0,
    });
    expect(client.crews.updateBudget).not.toHaveBeenCalled();
  });

  it("refuses a save that changes nothing", async () => {
    const user = userEvent.setup();
    const { client } = setup({ reason: "budget_uncertain" });
    const dialog = await openDialog(user);
    await within(dialog).findByText("120,000");
    await user.click(within(dialog).getByRole("radio", { name: "Block new work" }));
    await user.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(
      within(dialog).getByText(/Enter a new limit or change how unknown usage counts/),
    ).toBeTruthy();
    expect(client.crews.updateBudget).not.toHaveBeenCalled();
  });

  it("sends onUnknown with a raise only when the operator changes it", async () => {
    const user = userEvent.setup();
    const { c, client } = setup();
    const dialog = await openDialog(user);
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    expect(
      within(dialog).getByRole("radio", { name: "Block new work" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(dialog).getByRole("radio", { name: "Allow new work" }));
    await user.click(within(dialog).getByRole("button", { name: "Raise budget" }));
    expect(client.crews.updateBudget).toHaveBeenCalledWith(c.id, {
      limitTokens: 180_000,
      onUnknown: "allow",
      expectedVersion: 2,
    });
  });

  it("creates a hard budget for a crew that has none, with its unknown-usage rule", async () => {
    const user = userEvent.setup();
    const { c, client } = setup({ reason: "budget_uncertain", crewBudget: false });
    const dialog = await openDialog(user);
    expect(await within(dialog).findByText("None set")).toBeTruthy();
    const input = (await within(dialog).findByLabelText(/New token limit/)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("180000"));
    await user.click(within(dialog).getByRole("button", { name: "Create budget" }));
    expect(client.crews.updateBudget).toHaveBeenCalledWith(c.id, {
      limitTokens: 180_000,
      onUnknown: "allow",
      enforce: "hard",
    });
    expect(await screen.findByText("Budget created")).toBeTruthy();
  });
});
