import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { SpecsScreen } from "../screens/SpecsScreen.js";
import { spec } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { AppProviders, useLive, useLoad, useStore } from "./context.js";

/** A change stream the test drives: `push(v)` delivers a version, `drop()` ends the stream. */
function controllableStream() {
  let push: (v: number) => void = () => undefined;
  let drop: (err?: unknown) => void = () => undefined;
  const fn = vi.fn(
    (onChange: (v: number) => void) =>
      new Promise<void>((resolve, reject) => {
        push = onChange;
        drop = (err) => (err ? reject(err) : resolve());
        onChange(0);
      }),
  );
  return { fn, push: (v: number) => push(v), drop: (err?: unknown) => drop(err) };
}

afterEach(() => vi.useRealTimers());

describe("live changes", () => {
  it("shows a spec created elsewhere without a reload", async () => {
    const stream = controllableStream();
    const first = spec({ id: "s1", title: "Farewell" });
    const created = spec({
      id: "s9",
      lineageId: "l9",
      title: "Greet in Spanish, French or English",
    });
    let specs = [first];
    const api = mockApi({ streamChanges: stream.fn, listSpecs: () => Promise.resolve(specs) });
    renderWithStore(<SpecsScreen />, api);
    expect(await screen.findByText("Farewell")).toBeTruthy();
    expect(screen.queryByText(/Greet in Spanish/)).toBeNull();

    specs = [first, created];
    act(() => stream.push(1));
    expect(await screen.findByText(/Greet in Spanish/)).toBeTruthy();
  });

  it("refreshes quietly: the data stays on screen and an unchanged answer keeps the same object", async () => {
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    const loader = vi.fn(() => Promise.resolve({ n: 1 }));
    const seen: unknown[] = [];
    function Probe() {
      const { state } = useLoad(loader, []);
      seen.push(state.status === "ready" ? state.data : state.status);
      return <p>{state.status}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await screen.findByText("ready");
    const before = seen.length;
    const data = seen[before - 1];
    act(() => stream.push(1));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(seen.slice(before)).not.toContain("loading");
    expect(seen.slice(before).every((d) => d === data)).toBe(true);
  });

  it("bursts of changes collapse into one refresh per second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    const loader = vi.fn(() => Promise.resolve(1));
    function Probe() {
      useLoad(loader, []);
      return null;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await act(async () => undefined);
    expect(loader).toHaveBeenCalledTimes(1);
    act(() => {
      for (let v = 1; v <= 5; v++) stream.push(v);
    });
    await act(async () => undefined);
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(loader).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("says reconnecting when the stream drops, and live again once it is back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    function State() {
      return <p>{useLive().state}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <State />
      </AppProviders>,
    );
    await act(async () => undefined);
    expect(screen.getByText("live")).toBeTruthy();
    await act(async () => stream.drop());
    expect(screen.getByText("reconnecting")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(stream.fn).toHaveBeenCalledTimes(2);
    expect(screen.getByText("live")).toBeTruthy();
  });

  it("a rejected token signs out instead of retrying", async () => {
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    function Token() {
      return <p>{useStore().state.token ?? "signed out"}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Token />
      </AppProviders>,
    );
    await act(async () => undefined);
    await act(async () => stream.drop(new ApiError(401, "unauthorized", "bad token")));
    expect(await screen.findByText("signed out")).toBeTruthy();
    expect(stream.fn).toHaveBeenCalledTimes(1);
  });

  it("after a dropped stream, the first version on reconnect refreshes the pages", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    const loader = vi.fn(() => Promise.resolve(1));
    function Probe() {
      useLoad(loader, []);
      return null;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await act(async () => undefined);
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => stream.drop());
    await act(async () => vi.advanceTimersByTime(1_000));
    // The new connection's first version (0 again after a server restart) still catches up.
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("a manual Reconnect also catches the pages up", async () => {
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    const loader = vi.fn(() => Promise.resolve(1));
    let reconnect: () => void = () => undefined;
    function Probe() {
      useLoad(loader, []);
      reconnect = useLive().reconnect;
      return null;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await act(async () => undefined);
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => reconnect());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });

  it("a quiet refresh keeps data through an error, but shows a record that is gone", async () => {
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    let answer: () => Promise<string> = () => Promise.resolve("spec v1");
    function Probe() {
      const { state } = useLoad(() => answer(), []);
      return <p>{state.status === "ready" ? state.data : state.status}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await screen.findByText("spec v1");
    answer = () => Promise.reject(new ApiError(500, "internal", "blip"));
    act(() => stream.push(1));
    await act(async () => undefined);
    expect(screen.getByText("spec v1")).toBeTruthy();
    answer = () => Promise.reject(new ApiError(404, "not_found", "spec not found"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_100));
      stream.push(2);
    });
    expect(await screen.findByText("error")).toBeTruthy();
  });

  it("loaders marked live: false do not re-run on changes", async () => {
    const stream = controllableStream();
    const api = mockApi({ streamChanges: stream.fn });
    const loader = vi.fn(() => Promise.resolve(1));
    function Probe() {
      useLoad(loader, [], { live: false });
      return null;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <Probe />
      </AppProviders>,
    );
    await act(async () => undefined);
    act(() => stream.push(1));
    await act(async () => undefined);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("an older server without the stream falls back to a health check, not Offline forever", async () => {
    const api = mockApi({
      streamChanges: () => Promise.reject(new ApiError(404, "not_found", "route not found")),
      health: { status: "ok" },
    });
    function State() {
      const live = useLive();
      return <p>{`${live.state}:${live.streaming}`}</p>;
    }
    render(
      <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok" }}>
        <State />
      </AppProviders>,
    );
    expect(await screen.findByText("live:false")).toBeTruthy();
    expect(api.streamChanges).toHaveBeenCalledTimes(1);
  });
});
