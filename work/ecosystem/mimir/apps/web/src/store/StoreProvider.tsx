import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import { describeError, isUnauthorized, type MimirClient } from "../api/client.js";
import { initialState, needsSnapshotRefresh, reducer, type Action, type State } from "./reducer.js";

interface StoreValue {
  state: State;
  dispatch: Dispatch<Action>;
  client: MimirClient;
  /** Re-fetch the snapshot (and server attention). */
  refresh: () => Promise<void>;
  /** Reload the snapshot and restart the live stream from its cursor. */
  reconnect: () => void;
  /** Call with any SDK error from a mutation; a 401 sends the user back to the token prompt. */
  reportError: (error: unknown) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export interface StoreProviderProps {
  client: MimirClient;
  children: ReactNode;
  onUnauthorized?: () => void;
  /** Debounce for snapshot refreshes triggered by entity-creating events. */
  refreshDelayMs?: number;
}

export function StoreProvider({
  client,
  children,
  onUnauthorized,
  refreshDelayMs = 300,
}: StoreProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [epoch, bump] = useReducer((n: number) => n + 1, 0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const eventsRef = useRef(state.events);
  eventsRef.current = state.events;
  const loadedOnce = useRef(false);

  const loadSnapshot = useCallback(async (): Promise<string | null> => {
    const buffered = eventsRef.current;
    const lastEventIdAtRequest = loadedOnce.current ? (buffered.at(-1)?.id ?? null) : undefined;
    try {
      const snap = await client.snapshot();
      loadedOnce.current = true;
      dispatch({
        type: "snapshot/loaded",
        snapshot: snap,
        ...(lastEventIdAtRequest !== undefined ? { lastEventIdAtRequest } : {}),
      });
      // `GET /v1/attention` arrives with T12; until then the list is derived client-side.
      client.attention
        .list()
        .then((r) => dispatch({ type: "attention/loaded", items: r.items }))
        .catch(() => undefined);
      return snap.cursor;
    } catch (error) {
      if (isUnauthorized(error)) onUnauthorizedRef.current?.();
      dispatch({ type: "snapshot/failed", error: describeError(error).message });
      return null;
    }
  }, [client]);

  const refresh = useCallback(async () => {
    await loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!controller.signal.aborted) void loadSnapshot();
      }, refreshDelayMs);
    };

    const run = async () => {
      dispatch({ type: "connection/changed", connection: "connecting" });
      const cursor = await loadSnapshot();
      if (controller.signal.aborted || cursor === null) {
        if (cursor === null) dispatch({ type: "connection/changed", connection: "closed" });
        return;
      }
      try {
        const stream = client.events.stream({
          cursor,
          signal: controller.signal,
          onGap: (gap) =>
            dispatch({
              type: "stream/gap",
              reason: gap.reason ?? null,
              at: new Date().toISOString(),
            }),
          // The SDK reports connecting/open/reconnecting/closed; a received event also proves open.
          onStatus: (status) => dispatch({ type: "connection/changed", connection: status }),
        });
        for await (const event of stream) {
          if (controller.signal.aborted) break;
          dispatch({ type: "connection/changed", connection: "open" });
          dispatch({ type: "event/received", event });
          if (needsSnapshotRefresh(event)) scheduleRefresh();
        }
        if (!controller.signal.aborted) {
          dispatch({ type: "connection/changed", connection: "closed" });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) onUnauthorizedRef.current?.();
        dispatch({ type: "connection/changed", connection: "closed" });
      }
    };
    void run();
    return () => {
      controller.abort();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [client, loadSnapshot, refreshDelayMs, epoch]);

  const reportError = useCallback((error: unknown) => {
    if (isUnauthorized(error)) onUnauthorizedRef.current?.();
  }, []);
  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, client, refresh, reconnect: bump, reportError }),
    [state, client, refresh, reportError],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside <StoreProvider>");
  return value;
}
