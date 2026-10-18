import { useCallback, useEffect, useState } from "react";
import { describeError, isUnauthorized } from "../api/client.js";
import { useStore } from "../store/StoreProvider.js";

export type AsyncState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: null; error: string };

/** Runs `fn` on mount and whenever `key` changes; `reload` runs it again. */
export function useAsync<T>(
  fn: () => Promise<T>,
  key: string,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading", data: null, error: null });
  const [tick, setTick] = useState(0);
  const { reportError } = useStore();
  useEffect(() => {
    let live = true;
    setState({ status: "loading", data: null, error: null });
    fn().then(
      (data) => live && setState({ status: "ready", data, error: null }),
      (e: unknown) => {
        if (!live) return;
        // A rejected token sends the operator back to the token prompt; Retry could not help.
        if (isUnauthorized(e)) reportError(e);
        setState({ status: "error", data: null, error: describeError(e).message });
      },
    );
    return () => {
      live = false;
    };
    // `fn` is intentionally keyed by `key` so inline closures do not refetch every render.
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}
