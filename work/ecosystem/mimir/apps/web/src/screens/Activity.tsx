import type { EventEnvelope } from "@mimir/protocol";
import { useMemo, useState, type FormEvent } from "react";
import { describeError } from "../api/client.js";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { EventFilters } from "../components/EventFilters.js";
import { EventList } from "../components/EventList.js";
import { PageTitle, Section } from "../components/Section.js";
import { StoreGate } from "../components/StoreGate.js";
import { filterEvents, type EventFilter } from "../lib/derive.js";
import { loadHistory, mergeEvents } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";

/** Triggers a browser download of `events` as pretty JSON. */
export function downloadJson(events: readonly EventEnvelope[], filename: string): void {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Activity() {
  const { state, client } = useStore();
  const [filter, setFilter] = useState<EventFilter>({});
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState("");
  const [replayed, setReplayed] = useState<EventEnvelope[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const all = useMemo(() => mergeEvents(replayed, state.events), [replayed, state.events]);
  const shown = useMemo(() => filterEvents(all, { ...filter, search }), [all, filter, search]);

  const replay = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOutcome(null);
    try {
      const c = cursor.trim();
      const r = await loadHistory(client, c ? { cursor: c } : {});
      setReplayed(r.events);
      setOutcome({
        kind: "ok",
        message: `Replayed ${r.events.length} events${c ? ` from cursor ${c}` : " from the beginning"}${
          r.truncated ? ` (stopped early; continue from ${r.nextCursor ?? "?"})` : ""
        }.`,
      });
    } catch (err) {
      setOutcome({ kind: "error", error: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageTitle>Activity</PageTitle>
      <StoreGate label="activity">
        <form onSubmit={(e) => void replay(e)} className="mb-3 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Replay from cursor</span>
            <input
              className="input font-mono"
              value={cursor}
              placeholder="blank = from the beginning"
              onChange={(e) => setCursor(e.target.value)}
            />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            Replay
          </button>
        </form>
        <ActionResult outcome={outcome} />
        <div className="my-2 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Search events</span>
            <input
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <EventFilters filter={filter} onChange={setFilter} />
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadJson(
                shown,
                `mimir-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
              )
            }
          >
            Export JSON ({shown.length})
          </button>
        </div>
        <p className="text-sm" aria-live="polite">
          {shown.length} of {all.length} events shown
        </p>
        <Section title="Event log">
          <EventList events={shown} />
        </Section>
      </StoreGate>
    </>
  );
}
