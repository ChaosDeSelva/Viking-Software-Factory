import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./api/client.js";
import type { ExecutionStreamMessage } from "./api/delivery-types.js";
import type { Project } from "./api/types.js";
import { App } from "./App.js";
import { RunsScreen } from "./screens/RunsScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";
import { AppProviders, useStore } from "./store/context.js";
import { initialState, reducer } from "./store/reducer.js";
import { executionDetail } from "./test/delivery-fixtures.js";
import { projectPicker } from "./test/shell.js";
import { mockApi, renderWithStore } from "./test/utils.js";

/** A change stream the test drives: `push(v)` delivers a version. */
function controllableStream() {
  let push: (v: number) => void = () => undefined;
  const fn = vi.fn(
    (onChange: (v: number) => void) =>
      new Promise<void>(() => {
        push = onChange;
        onChange(0);
      }),
  );
  return { fn, push: (v: number) => push(v) };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => sessionStorage.clear());

describe("sweep 3", () => {
  it("Settings: a live refresh does not overwrite unsaved edits", async () => {
    const stream = controllableStream();
    let settings = { provider: "null", model: "claude-fable-5-1", localOnly: true };
    const api = mockApi({
      streamChanges: stream.fn,
      getSettings: () => Promise.resolve({ settings, tokenLocation: null }),
    });
    renderWithStore(<SettingsScreen />, api);
    const model = (await screen.findByLabelText("Model")) as HTMLInputElement;
    await userEvent.clear(model);
    await userEvent.type(model, "my-model");
    // Something else changes the settings while the form has unsaved edits.
    settings = { ...settings, localOnly: false };
    act(() => stream.push(1));
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("my-model");
  });

  it("Settings: an untouched form follows a live refresh", async () => {
    const stream = controllableStream();
    let settings = { provider: "null", model: "claude-fable-5-1", localOnly: true };
    const api = mockApi({
      streamChanges: stream.fn,
      getSettings: () => Promise.resolve({ settings, tokenLocation: null }),
    });
    renderWithStore(<SettingsScreen />, api);
    await screen.findByLabelText("Model");
    settings = { ...settings, model: "other-model" };
    act(() => stream.push(1));
    await waitFor(() =>
      expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("other-model"),
    );
  });

  it("a project that disappears from the list takes its selections with it", () => {
    const s = reducer(
      {
        ...initialState({ token: "t" }),
        projects: [{ id: "p1", name: "One", repoPath: "/r/1" }],
        projectId: "p1",
        specId: "s1",
        planId: "pl1",
        executionId: "e1",
        deliveryId: "d1",
        directorSeed: { intakeId: "i1", request: "x" },
      },
      { type: "projects/loaded", projects: [{ id: "p2", name: "Two", repoPath: "/r/2" }] },
    );
    expect(s.projectId).toBe("p2");
    expect([s.specId, s.planId, s.executionId, s.deliveryId, s.directorSeed]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("the project picker keeps the newest project list when refreshes answer out of order", async () => {
    const stream = controllableStream();
    const P1: Project = { id: "p1", name: "One", repoPath: "/repo/one" };
    const P2: Project = { id: "p2", name: "Two", repoPath: "/repo/two" };
    const slow = deferred<Project[]>();
    const fast = deferred<Project[]>();
    const api = mockApi({
      streamChanges: stream.fn,
      reviews: { approvals: [], escalations: [], budgetAlerts: [] },
      listIntakes: [],
      getSettings: { settings: { provider: "null", model: "m", localOnly: true } },
    });
    api.listProjects
      .mockResolvedValueOnce([P1])
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);
    render(
      <App
        api={api as unknown as ApiClient}
        initial={{ token: "t", projects: [P1], projectId: "p1", view: "inbox" }}
      />,
    );
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(1));
    act(() => stream.push(1));
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_100));
      stream.push(2);
    });
    await waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(3));
    await act(async () => fast.resolve([P1, P2]));
    await act(async () => slow.resolve([P1]));
    await userEvent.click(projectPicker());
    expect(await screen.findByRole("option", { name: /^Two/ })).toBeTruthy();
  });

  it("Runs: a live refresh newer than the last stream refresh is shown", async () => {
    const stream = controllableStream();
    let pushRun: (m: ExecutionStreamMessage) => void = () => undefined;
    let detail = executionDetail({
      execution: { ...executionDetail().execution, status: "running" },
      approvals: [],
    });
    const api = mockApi({
      streamChanges: stream.fn,
      listExecutions: [
        {
          id: "e1",
          planId: "pl1",
          planVersion: 1,
          projectId: "p1",
          status: "running",
          mimirMissionId: "msn_1",
          createdAt: "2026-01-01T00:00:00Z",
          finishedAt: null,
        },
      ],
      getExecution: () => Promise.resolve(detail),
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        pushRun = on;
        return new Promise<void>(() => undefined);
      },
    });
    renderWithStore(<RunsScreen />, api, { executionId: "e1" });
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeTruthy();
    // A task event refreshes the run through the run's own stream.
    await act(async () =>
      pushRun({
        kind: "event",
        data: {
          id: "1",
          mimirEventId: "m_1",
          type: "task.completed",
          payload: {},
          occurredAt: "2026-01-01T00:00:01Z",
        },
      }),
    );
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    // Then the run fails; Sindri's change stream reports it before the run stream says anything.
    detail = executionDetail({
      execution: { ...executionDetail().execution, status: "failed" },
      approvals: [],
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_100));
      stream.push(1);
    });
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull());
  });
});

describe("sweep 3: change stream", () => {
  it("a 401 from a stream opened with the previous token does not sign out the new one", async () => {
    let rejectFirst: (e: unknown) => void = () => undefined;
    const api = mockApi();
    api.streamChanges
      .mockImplementationOnce(() => new Promise<void>((_r, reject) => (rejectFirst = reject)))
      .mockImplementation(() => new Promise<void>(() => undefined));
    let dispatch: ReturnType<typeof useStore>["dispatch"] = () => undefined;
    function Token() {
      const store = useStore();
      dispatch = store.dispatch;
      return <p>{store.state.token ?? "signed out"}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "old" }}>
        <Token />
      </AppProviders>,
    );
    await act(async () => undefined);
    act(() => dispatch({ type: "token/clear" }));
    act(() => dispatch({ type: "token/set", token: "new" }));
    await act(async () => rejectFirst(new ApiError(401, "unauthorized", "bad token")));
    expect(screen.getByText("new")).toBeTruthy();
  });
});
