import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
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
const THEME_KEY = "sindri.theme";

export function readInitial(): Partial<State> {
  const token = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(TOKEN_KEY);
  const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_KEY);
  return {
    token,
    theme: stored === "dark" || stored === "light" ? stored : "light",
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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", state.theme === "dark");
    document.documentElement.style.colorScheme = state.theme;
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, state.theme);
  }, [state.theme]);

  return (
    <ApiContext.Provider value={props.api}>
      <StoreContext.Provider value={{ state, dispatch }}>{props.children}</StoreContext.Provider>
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

/** Load data for a screen; `reload()` re-runs the loader. A null loader stays idle (loading). */
export function useLoad<T>(loader: (() => Promise<T>) | null, deps: unknown[]) {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const report = useReportError();
  useEffect(() => {
    if (!loader) return;
    let live = true;
    setState({ status: "loading" });
    loader().then(
      (data) => live && setState({ status: "ready", data }),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) report(err);
        setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { state, reload: () => setTick((t) => t + 1), setState };
}
