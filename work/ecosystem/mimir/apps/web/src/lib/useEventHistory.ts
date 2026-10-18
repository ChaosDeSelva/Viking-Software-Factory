import type { EventEnvelope, ListEventsQuery } from "@mimir/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, type MimirClient } from "../api/client.js";

export const HISTORY_PAGE = 500;
export const HISTORY_MAX_PAGES = 20;

/** Pages `GET /v1/events` from `query.cursor` until caught up (bounded). */
export async function loadHistory(
  client: MimirClient,
  query: Omit<ListEventsQuery, "limit">,
  signal?: AbortSignal,
): Promise<{ events: EventEnvelope[]; truncated: boolean; nextCursor: string | null }> {
  const events: EventEnvelope[] = [];
  let cursor = query.cursor;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    if (signal?.aborted) break;
    const res = await client.events.list({
      ...query,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: HISTORY_PAGE,
    });
    events.push(...res.events);
    if (!res.hasMore || res.nextCursor === null || res.events.length === 0) {
      return { events, truncated: false, nextCursor: res.lastCursor };
    }
    cursor = res.nextCursor;
  }
  return { events, truncated: true, nextCursor: cursor ?? null };
}

/** Merge history and live events, dedupe by id, keep order by occurredAt then arrival. */
export function mergeEvents(
  a: readonly EventEnvelope[],
  b: readonly EventEnvelope[],
): EventEnvelope[] {
  const seen = new Set<string>();
  const out: EventEnvelope[] = [];
  for (const e of [...a, ...b]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((x, y) =>
    x.occurredAt < y.occurredAt ? -1 : x.occurredAt > y.occurredAt ? 1 : 0,
  );
}

/** History for a mission merged with live events from the store. */
export function useMissionEvents(
  client: MimirClient,
  missionId: string,
  live: readonly EventEnvelope[],
) {
  const [history, setHistory] = useState<EventEnvelope[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const ctrl = new AbortController();
    setStatus("loading");
    setError(null);
    loadHistory(client, { missionId }, ctrl.signal).then(
      (r) => {
        if (ctrl.signal.aborted) return;
        setHistory(r.events);
        setStatus("ready");
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(describeError(e).message);
        setStatus("error");
      },
    );
    return () => ctrl.abort();
  }, [client, missionId, tick]);
  const events = useMemo(
    () =>
      mergeEvents(
        history,
        live.filter((e) => e.missionId === missionId),
      ),
    [history, live, missionId],
  );
  return { events, status, error, reload };
}
