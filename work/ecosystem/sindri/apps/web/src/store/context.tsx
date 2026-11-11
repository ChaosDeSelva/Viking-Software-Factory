import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import type { ConnectionState } from "@factory/ui";
import { ApiError, type ApiClient } from "../api/client.js";
import { initialState, reducer, type Action, type State } from "./reducer.js";
import { parseHash, routeHash } from "./route.js";

interface Store {
  state: State;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<Store | null>(null);
const ApiContext = createContext<ApiClient | null>(null);

export const TOKEN_KEY = "sindri.token";

/** The server's change stream: its connection state, and a version that moves after any write. */
export interface LiveChanges {
  state: ConnectionState;
  version: number;
  /** False when the server has no change stream (older Sindri): pages then update on reload only. */
  streaming: boolean;
  reconnect: () => void;
}
const LiveContext = createContext<LiveChanges>({
  state: "connecting",
  version: 0,
  streaming: true,
  reconnect: () => undefined,
});
/** Backoff between reconnect attempts; after the third failure the bar says Offline. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
/** Writes during a run arrive several times a second; pages refresh at most this often. */
export const REFRESH_THROTTLE_MS = 1_000;
/** Without a change stream, reachability is checked this often. */
const HEALTH_MS = 30_000;

/**
 * Keeps `/v1/changes` open while signed in, reconnecting with backoff when it drops. The first
 * version of a session is only a baseline (pages have just loaded); after a dropped stream or a
 * manual Reconnect the first version always refreshes the pages, since writes may have been missed.
 */
function useChangeStream(
  api: ApiClient,
  token: string | null,
  onRejected: () => void,
): LiveChanges {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [streaming, setStreaming] = useState(true);
  // Survives reconnects: whether the next connection must catch the pages up.
  const catchUp = useRef(false);
  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    let latest: number | null = null;
    let shown: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let health: ReturnType<typeof setInterval> | undefined;
    // Trailing throttle: the first change shows at once, a burst collapses into one refresh.
    const publish = () => {
      timer = undefined;
      if (latest === null || latest === shown) return;
      shown = latest;
      setVersion((v) => v + 1);
      timer = setTimeout(publish, REFRESH_THROTTLE_MS);
    };
    // Older server without /v1/changes: say whether it is reachable, and nothing more.
    const pollHealth = () => {
      setStreaming(false);
      const check = () =>
        api.health().then(
          () => !ctrl.signal.aborted && setState("live"),
          () => !ctrl.signal.aborted && setState("offline"),
        );
      void check();
      health = setInterval(check, HEALTH_MS);
    };
    const connect = () => {
      setState(failures === 0 ? "connecting" : failures < 3 ? "reconnecting" : "offline");
      let first = true;
      api
        .streamChanges((v) => {
          failures = 0;
          setStreaming(true);
          setState("live");
          latest = v;
          if (first) {
            first = false;
            if (!catchUp.current) {
              shown = v;
              return;
            }
            catchUp.current = false;
            shown = null;
          }
          if (!timer) publish();
        }, ctrl.signal)
        .then(
          () => undefined,
          (err: unknown) => {
            // A stream opened with an earlier token must not sign out the current one.
            if (ctrl.signal.aborted) return "stop";
            if (err instanceof ApiError && err.status === 401) {
              onRejected();
              return "stop";
            }
            if (err instanceof ApiError && err.status === 404) return "unsupported";
            return undefined;
          },
        )
        .then((outcome) => {
          if (ctrl.signal.aborted || outcome === "stop") return;
          if (outcome === "unsupported") return pollHealth();
          catchUp.current = true;
          failures += 1;
          setState(failures < 3 ? "reconnecting" : "offline");
          retry = setTimeout(connect, RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
        });
    };
    connect();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      clearTimeout(retry);
      clearInterval(health);
    };
  }, [api, token, attempt]);
  return {
    state,
    version,
    streaming,
    reconnect: () => {
      catchUp.current = true;
      setAttempt((n) => n + 1);
    },
  };
}

/** Live connection state and the change version, for the bottom bar and useLoad. */
export function useLive(): LiveChanges {
  return useContext(LiveContext);
}
/** Pre-redesign theme key; moved once to the shared `factory-theme` the bottom bar owns. */
const LEGACY_THEME_KEY = "sindri.theme";

export function migrateTheme(): void {
  try {
    const old = localStorage.getItem(LEGACY_THEME_KEY);
    if (old === null) return;
    if ((old === "dark" || old === "light") && localStorage.getItem("factory-theme") === null)
      localStorage.setItem("factory-theme", old);
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    /* no storage (outside a browser, or blocked) */
  }
}

export function readInitial(): Partial<State> {
  const token = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(TOKEN_KEY);
  return {
    token,
    ...(typeof location === "undefined" ? {} : parseHash(location.hash)),
  };
}

export function AppProviders(props: {
  api: ApiClient;
  initial?: Partial<State>;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    ...initialState({}),
    ...props.initial,
  }));

  // The token lives in sessionStorage only (cleared when the tab closes).
  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  }, [state.token]);
  // Sign-out and a rejected token also drop the approval secret held by the client.
  useEffect(() => {
    if (!state.token) props.api.forgetApproval();
  }, [state.token, props.api]);

  // URL hash routes (audit S-I1): state -> hash (a history entry per change), Back/Forward and
  // edited hashes -> state.
  const hash = routeHash(state);
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash === hash) return;
    if (!window.location.hash) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
  }, [hash]);
  useEffect(() => {
    const onPop = () => {
      const route = parseHash(window.location.hash);
      if (route.view) dispatch({ type: "route", route });
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  const live = useChangeStream(props.api, state.token, () => dispatch({ type: "auth/rejected" }));

  return (
    <ApiContext.Provider value={props.api}>
      <StoreContext.Provider value={{ state, dispatch }}>
        <LiveContext.Provider value={live}>{props.children}</LiveContext.Provider>
      </StoreContext.Provider>
    </ApiContext.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore outside AppProviders");
  return s;
}

export function useApi(): ApiClient {
  const a = useContext(ApiContext);
  if (!a) throw new Error("useApi outside AppProviders");
  return a;
}

/** Turn an error into a notice; a 401 clears the token so the prompt reappears. */
export function useReportError() {
  const { dispatch } = useStore();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) dispatch({ type: "auth/rejected" });
      else
        dispatch({
          type: "notice",
          notice: { kind: "error", text: err instanceof Error ? err.message : String(err) },
        });
    },
    [dispatch],
  );
}

export type Loadable<T> =
  { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: T };

/**
 * Load data for a screen; `reload()` re-runs the loader. A null loader stays idle (loading).
 * When the server reports a change the loader re-runs quietly: the current data stays on screen,
 * a failed refresh keeps it, and an unchanged answer keeps the same object so nothing re-renders
 * (forms seeded from it are not reset).
 */
export function useLoad<T>(
  loader: (() => Promise<T>) | null,
  deps: unknown[],
  opts: {
    /** False for loaders that call out to Mimir, Feedback Graph or the repository: they do not
     * re-run on every database change, only on their deps and reload(). */
    live?: boolean;
  } = {},
) {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const liveVersion = useLive().version;
  const version = opts.live === false ? 0 : liveVersion;
  const report = useReportError();
  const current = useRef(state);
  current.current = state;
  const seen = useRef({ deps, tick, version });
  useEffect(() => {
    if (!loader) return;
    const prev = seen.current;
    seen.current = { deps, tick, version };
    const quiet =
      prev.version !== version &&
      prev.tick === tick &&
      prev.deps.length === deps.length &&
      prev.deps.every((d, i) => Object.is(d, deps[i])) &&
      current.current.status === "ready";
    let live = true;
    if (!quiet) setState({ status: "loading" });
    loader().then(
      (data) => {
        if (!live) return;
        setState((s) =>
          quiet && s.status === "ready" && sameJson(s.data, data) ? s : { status: "ready", data },
        );
      },
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) report(err);
        // A quiet refresh keeps what is shown through a blip, but not for a record that is gone.
        if (quiet && !(err instanceof ApiError && err.status === 404)) return;
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick, version]);
  return { state, reload: () => setTick((t) => t + 1), setState };
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
