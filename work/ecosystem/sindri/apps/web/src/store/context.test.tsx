import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "../api/client.js";
import { mockApi } from "../test/utils.js";
import {
  AppProviders,
  readInitial,
  TOKEN_KEY,
  useApi,
  useLoad,
  useReportError,
  useStore,
} from "./context.js";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const wrap =
  (api = mockApi(), initial = {}) =>
  ({ children }: { children: ReactNode }) => (
    <AppProviders api={api as unknown as ApiClient} initial={{ token: "tok", ...initial }}>
      {children}
    </AppProviders>
  );

function Show() {
  const { state } = useStore();
  return <output data-testid="state">{`${state.view}:${state.notice?.text ?? ""}`}</output>;
}

describe("readInitial", () => {
  it("reads the token, a valid theme and the hash route", () => {
    sessionStorage.setItem(TOKEN_KEY, "t1");
    localStorage.setItem("sindri.theme", "dark");
    window.history.replaceState(null, "", "/#/plans?project=p1&plan=pl1");
    expect(readInitial()).toMatchObject({
      token: "t1",
      theme: "dark",
      view: "plans",
      projectId: "p1",
      planId: "pl1",
    });
    localStorage.setItem("sindri.theme", "purple");
    expect(readInitial().theme).toBe("light");
  });

  it("works without web storage or a location (outside a browser)", () => {
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("location", undefined);
    expect(readInitial()).toEqual({ token: null, theme: "light" });
  });
});

describe("AppProviders", () => {
  it("still renders when web storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("localStorage", undefined);
    render(
      <AppProviders api={mockApi() as unknown as ApiClient} initial={{ token: "tok" }}>
        <Show />
      </AppProviders>,
    );
    expect(screen.getByTestId("state").textContent).toBe("projects:");
  });

  it("ignores a Back/Forward to a hash that names no view", () => {
    render(
      <AppProviders
        api={mockApi() as unknown as ApiClient}
        initial={{ token: "tok", view: "runs" }}
      >
        <Show />
      </AppProviders>,
    );
    act(() => {
      window.history.replaceState(null, "", "/#/nowhere");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("state").textContent).toBe("runs:");
    act(() => {
      window.history.replaceState(null, "", "/#/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("state").textContent).toBe("settings:");
  });
});

describe("hooks outside the providers", () => {
  it("throw a clear error", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useStore())).toThrow("useStore outside AppProviders");
    expect(() => renderHook(() => useApi())).toThrow("useApi outside AppProviders");
    quiet.mockRestore();
  });
});

describe("useReportError", () => {
  it("reports a thrown non-Error as text", () => {
    const { result } = renderHook(() => ({ report: useReportError(), store: useStore() }), {
      wrapper: wrap(),
    });
    act(() => result.current.report("plain failure"));
    expect(result.current.store.state.notice).toEqual({ kind: "error", text: "plain failure" });
  });
});

describe("useLoad", () => {
  it("shows a non-Error rejection as text and ends the session on a 401", async () => {
    const { result } = renderHook(
      () => ({ load: useLoad(() => Promise.reject("odd failure"), []), store: useStore() }),
      { wrapper: wrap() },
    );
    await vi.waitFor(() =>
      expect(result.current.load.state).toEqual({ status: "error", error: "odd failure" }),
    );
    expect(result.current.store.state.token).toBe("tok");

    const unauthorized = renderHook(
      () => ({
        load: useLoad(() => Promise.reject(new ApiError(401, "unauthorized", "bad token")), []),
        store: useStore(),
      }),
      { wrapper: wrap() },
    );
    await vi.waitFor(() =>
      expect(unauthorized.result.current.load.state).toEqual({
        status: "error",
        error: "bad token",
      }),
    );
    expect(unauthorized.result.current.store.state.token).toBeNull();
  });

  it("drops answers that arrive after the deps changed, success or failure", async () => {
    const answers: Record<string, { ok: (v: string) => void; fail: (e: unknown) => void }> = {};
    const loader = (key: string) => () =>
      new Promise<string>((ok, fail) => (answers[key] = { ok, fail }));
    const { result, rerender } = renderHook(({ k }) => useLoad(loader(k), [k]), {
      wrapper: wrap(),
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    rerender({ k: "c" });
    await act(async () => answers.c!.ok("from c"));
    expect(result.current.state).toEqual({ status: "ready", data: "from c" });
    await act(async () => answers.a!.ok("from a"));
    await act(async () => answers.b!.fail(new ApiError(401, "unauthorized", "stale")));
    expect(result.current.state).toEqual({ status: "ready", data: "from c" });
  });

  it("stays loading without a loader", () => {
    const { result } = renderHook(() => useLoad(null, []), { wrapper: wrap() });
    expect(result.current.state).toEqual({ status: "loading" });
  });
});
