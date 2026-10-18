import { newId } from "@mimir/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { event, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { StoreProvider, useStore } from "./StoreProvider.js";

function Probe() {
  const { state } = useStore();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="connection">{state.connection}</span>
      <span data-testid="tasks">{state.tasks.map((t) => `${t.title}:${t.status}`).join(",")}</span>
      <span data-testid="gap">{state.gap ? "gap" : "none"}</span>
      <span data-testid="error">{state.error ?? ""}</span>
    </div>
  );
}

describe("StoreProvider", () => {
  it("loads the snapshot then streams from its cursor", async () => {
    const t = task({ title: "A", status: "ready" });
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ tasks: [t], cursor: "c7" })),
    });
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    expect(client.streamController.last?.cursor).toBe("c7");

    act(() => {
      client.streamController.last?.onStatus?.("open");
      client.streamController.push(
        event(
          "task.leased",
          {
            from: "ready",
            to: "leased",
            agentId: newId("agt"),
            attempt: 1,
            leaseExpiresAt: "2026-10-14T11:00:00.000Z",
          },
          { taskId: t.id },
        ),
      );
    });
    await waitFor(() => expect(screen.getByTestId("tasks").textContent).toBe("A:leased"));
    expect(screen.getByTestId("connection").textContent).toBe("open");
  });

  it("stays Connecting on a quiet server until the SDK reports open", async () => {
    const client = mockClient();
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    expect(screen.getByTestId("connection").textContent).toBe("connecting");
    act(() => client.streamController.last?.onStatus?.("open"));
    expect(screen.getByTestId("connection").textContent).toBe("open");
  });

  it("shows reconnecting during SDK backoff, never Live, then Live again when the SDK reopens", async () => {
    const client = mockClient();
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    const opts = client.streamController.last;
    act(() => opts?.onStatus?.("open"));
    act(() => client.streamController.push(event("task.ready", { from: "pending", to: "ready" })));
    await waitFor(() => expect(screen.getByTestId("connection").textContent).toBe("open"));
    act(() => opts?.onStatus?.("reconnecting"));
    expect(screen.getByTestId("connection").textContent).toBe("reconnecting");
    act(() => opts?.onStatus?.("open"));
    expect(screen.getByTestId("connection").textContent).toBe("open");
  });

  it("maps SDK closed status", async () => {
    const client = mockClient();
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onStatus?.("closed"));
    expect(screen.getByTestId("connection").textContent).toBe("closed");
  });

  it("shows a gap when the SDK reports one", async () => {
    const client = mockClient();
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onGap?.({ reason: "slow consumer" }));
    expect(screen.getByTestId("gap").textContent).toBe("gap");
  });

  it("refreshes the snapshot after an entity-creating event", async () => {
    const client = mockClient();
    render(
      <StoreProvider client={client} refreshDelayMs={0}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    act(() =>
      client.streamController.push(
        event("task.created", {
          missionId: newId("msn"),
          crewId: null,
          title: "N",
          acceptance: "",
          dependsOn: [],
        }),
      ),
    );
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
  });

  it("keeps a live event that arrives while a stale snapshot refresh is in flight", async () => {
    const t = task({ title: "A", status: "running" });
    let release: (() => void) | null = null;
    const snapshotFn = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ tasks: [t] }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(snapshot({ tasks: [t] }));
          }),
      );
    const client = mockClient({ snapshot: snapshotFn });
    render(
      <StoreProvider client={client} refreshDelayMs={0}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() =>
      client.streamController.push(
        event("task.created", {
          missionId: newId("msn"),
          crewId: null,
          title: "N",
          acceptance: "",
          dependsOn: [],
        }),
      ),
    );
    await waitFor(() => expect(snapshotFn).toHaveBeenCalledTimes(2));
    act(() =>
      client.streamController.push(
        event("task.verifying", { from: "running", to: "verifying" }, { taskId: t.id }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("tasks").textContent).toBe("A:verifying"));
    await act(async () => release?.());
    await waitFor(() => expect(snapshotFn).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("tasks").textContent).toBe("A:verifying");
  });

  it("reports snapshot errors", async () => {
    const client = mockClient({ snapshot: vi.fn(async () => Promise.reject(new Error("down"))) });
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(screen.getByTestId("error").textContent).toBe("down");
  });

  it("marks the connection closed when the stream fails and calls onUnauthorized for 401s", async () => {
    const onUnauthorized = vi.fn();
    const client = mockClient();
    render(
      <StoreProvider client={client} onUnauthorized={onUnauthorized}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    const err = Object.assign(new Error("bad token"), {
      name: "MimirError",
      code: "unauthorized",
      status: 401,
    });
    act(() => client.streamController.fail(err));
    await waitFor(() => expect(screen.getByTestId("connection").textContent).toBe("closed"));
    expect(onUnauthorized).toHaveBeenCalled();
  });

  it("aborts the stream on unmount", async () => {
    const client = mockClient();
    const { unmount } = render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    unmount();
    expect(client.streamController.last?.signal.aborted).toBe(true);
  });
});
