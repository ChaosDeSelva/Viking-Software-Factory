import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { agent, event, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { AgentInspector, TERMINAL_MIN_INTERVAL_MS } from "./AgentInspector.js";

afterEach(() => vi.useRealTimers());

function setup({ noTerminal = false } = {}) {
  const t = task({ title: "Implement parser", status: "running" });
  const ag = agent({ taskId: t.id, status: "running", agentKind: "claude" });
  const sessionId = ag.runtimeSessionId as string;
  const client = mockClient({
    snapshot: vi.fn(async () => snapshot({ tasks: [t], agents: [ag] })),
  });
  if (noTerminal) {
    const caps = client.capabilities;
    client.capabilities = vi.fn(async () => {
      const c = await caps();
      return c.runtime
        ? {
            ...c,
            runtime: { ...c.runtime, features: { ...c.runtime.features, terminalRead: false } },
          }
        : c;
    });
  }
  const view = renderWithStore(<AgentInspector />, {
    client,
    route: `/agents/${sessionId}`,
    path: "/agents/:sessionId",
  });
  return { t, ag, sessionId, client, ...view };
}

describe("AgentInspector", () => {
  it("shows observed state, task and session ref", async () => {
    const { t, sessionId, container } = setup();
    expect(await screen.findByRole("heading", { level: 1, name: /Agent/ })).toBeTruthy();
    const state = screen.getByRole("region", { name: "State" });
    expect(within(state).getByText("running")).toBeTruthy();
    expect(within(state).getByText("observed")).toBeTruthy();
    expect(within(state).getByText("Implement parser").closest("a")?.getAttribute("href")).toBe(
      `/missions/${t.missionId}`,
    );
    expect(within(state).getByText(sessionId)).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("reads the terminal on demand only and rate-limits refresh to 2 s", async () => {
    const user = userEvent.setup();
    const { client, sessionId } = setup();
    await screen.findByRole("region", { name: "Terminal" });
    expect(client.sessions.terminal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Read terminal" }));
    expect(client.sessions.terminal).toHaveBeenCalledWith(sessionId, { lines: 200 });
    const pre = await screen.findByTestId("terminal");
    expect(pre.textContent).toContain("$ echo hi");
    expect(pre.tagName).toBe("PRE");
    const refresh = screen.getByRole("button", { name: "Refresh terminal" });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false), {
      timeout: TERMINAL_MIN_INTERVAL_MS + 1000,
    });
    expect(client.sessions.terminal).toHaveBeenCalledTimes(1);
    expect(TERMINAL_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
  });

  it("renders terminal text as text (no HTML) and shows no provenance the server did not send", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    vi.mocked(client.sessions.terminal!).mockResolvedValueOnce({
      text: '<img src=x onerror="window.__pwned=1">',
    });
    await user.click(await screen.findByRole("button", { name: "Read terminal" }));
    const pre = await screen.findByTestId("terminal");
    expect(pre.textContent).toBe('<img src=x onerror="window.__pwned=1">');
    expect(pre.querySelector("img")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Terminal" })).queryByText("observed"),
    ).toBeNull();
  });

  it("explains when the runtime cannot read terminals", async () => {
    setup({ noTerminal: true });
    const region = await screen.findByRole("region", { name: "Terminal" });
    await waitFor(() => expect(region.textContent).toMatch(/does not support terminal reads/i));
    expect(screen.queryByRole("button", { name: "Read terminal" })).toBeNull();
  });

  it("sends an instruction", async () => {
    const user = userEvent.setup();
    const { client, sessionId } = setup();
    await user.type(await screen.findByLabelText("Instruction"), "please add tests");
    await user.click(screen.getByRole("button", { name: "Send instruction" }));
    expect(client.sessions.input).toHaveBeenCalledWith(sessionId, { text: "please add tests" });
    expect(await screen.findByText(/Instruction sent/)).toBeTruthy();
  });

  it("soft stop is direct; force stop states the approval requirement and confirms", async () => {
    const user = userEvent.setup();
    const { client, sessionId } = setup();
    await user.click(await screen.findByRole("button", { name: "Soft stop" }));
    expect(client.sessions.stop).toHaveBeenCalledWith(sessionId, { mode: "soft" });
    expect(screen.getByText(/requires an approved runtime.force_stop/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Force stop…" }));
    expect(client.sessions.stop).toHaveBeenCalledTimes(1);
    vi.mocked(client.sessions.stop).mockRejectedValueOnce(
      Object.assign(new Error("force stop requires approval"), {
        name: "MimirError",
        code: "policy_denied",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Confirm force stop" }));
    expect(client.sessions.stop).toHaveBeenLastCalledWith(sessionId, { mode: "force" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/policy_denied/);
    expect(screen.getByRole("link", { name: /Reviews/ })).toBeTruthy();
  });

  it("shows the session timeline from live events", async () => {
    const { client, ag } = setup();
    await screen.findByRole("region", { name: "Timeline" });
    act(() =>
      client.streamController.push(
        event(
          "session.state_changed",
          { from: "running", to: "waiting" },
          { sessionId: ag.runtimeSessionId as never },
        ),
      ),
    );
    const tl = screen.getByRole("region", { name: "Timeline" });
    await waitFor(() => expect(within(tl).getByText("session.state_changed")).toBeTruthy());
  });

  it("shows agent cost with sources", async () => {
    const { client, ag } = setup();
    await screen.findByRole("region", { name: "Cost" });
    await waitFor(() => expect(client.usage.get).toHaveBeenCalledWith({ agentId: ag.id }));
    expect(await screen.findByText("unavailable: 0")).toBeTruthy();
  });

  it("shows not found for an unknown session", async () => {
    renderWithStore(<AgentInspector />, {
      client: mockClient(),
      route: "/agents/ses_x",
      path: "/agents/:sessionId",
    });
    expect(await screen.findByText(/No agent is bound to session/)).toBeTruthy();
  });
});
