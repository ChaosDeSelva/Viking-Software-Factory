import type { EventEnvelope } from "@mimir/protocol";
import { Button, Card, Field, InfoHint, Input } from "@factory/ui";
import { useMemo, useState, type FormEvent } from "react";
import { describeError } from "../api/client.js";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { EventFilters } from "../components/EventFilters.js";
import { EventList } from "../components/EventList.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { StoreGate } from "../components/StoreGate.js";
import { filterEvents, type EventFilter } from "../lib/derive.js";
import { useProjectScope, useScoped } from "../lib/scope.js";
import {
  loadHistory,
  loadScopedHistory,
  mergeEvents,
  type MissionCursors,
} from "../lib/useEventHistory.js";
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

/** Where "Continue" picks up a truncated replay, for the project it was loaded in. */
type Resume = { projectId: string | null } & ({ cursor: string } | { missions: MissionCursors });

export function Activity() {
  const { client, reportError } = useStore();
  const scoped = useScoped();
  const { project } = useProjectScope();
  const [filter, setFilter] = useState<EventFilter>({});
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState("");
  const [replayed, setReplayed] = useState<EventEnvelope[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);

  // Replayed history is kept as loaded; the project filter applies to it and to live events alike.
  const all = useMemo(
    () => mergeEvents(replayed.filter(scoped.eventInScope), scoped.events),
    [replayed, scoped],
  );
  const shown = useMemo(() => filterEvents(all, { ...filter, search }), [all, filter, search]);

  const replay = async (from: Resume | null) => {
    setBusy(true);
    setOutcome(null);
    try {
      const c = from ? ("cursor" in from ? from.cursor : "") : cursor.trim();
      const query = c ? { cursor: c } : {};
      // A project replays per mission (server-side `missionId` filter); All replays everything.
      const r =
        scoped.missionIds === null
          ? { ...(await loadHistory(client, query)), resume: new Map() as MissionCursors }
          : await loadScopedHistory(
              client,
              scoped.missionIds,
              query,
              undefined,
              from && "missions" in from ? from.missions : undefined,
            );
      setReplayed((prev) => (from ? mergeEvents(prev, r.events) : r.events));
      const projectId = project?.id ?? null;
      const next: Resume | null = !r.truncated
        ? null
        : r.resume.size > 0
          ? { projectId, missions: r.resume }
          : r.nextCursor
            ? { projectId, cursor: r.nextCursor }
            : null;
      setResume(next);
      const stopped = !r.truncated
        ? ""
        : next && "cursor" in next
          ? ` (stopped early; Continue resumes from cursor ${next.cursor})`
          : next
            ? ` (stopped early; Continue loads the rest of ${next.missions.size} mission${
                next.missions.size === 1 ? "" : "s"
              })`
            : " (stopped early)";
      setOutcome({
        kind: "ok",
        message: `${from ? "Continued: loaded" : "Replayed"} ${r.events.length} events${
          from ? "" : c ? ` from cursor ${c}` : " from the beginning"
        }${stopped}.`,
      });
    } catch (err) {
      reportError(err);
      setOutcome({ kind: "error", error: describeError(err) });
    } finally {
      setBusy(false);
    }
  };
  // A resume point from another project's replay would load events this view filters out.
  const canContinue = resume !== null && resume.projectId === (project?.id ?? null);

  return (
    <Screen
      screen="activity"
      title="Activity"
      term="Event stream"
      description="Every event Mimir records: live as it happens, older ones on request. Filter, search and export."
    >
      <StoreGate label="activity">
        <Card
          title="Load history"
          headingLevel={2}
          description={
            project
              ? `Replays recorded events of ${project.name}'s missions.`
              : "Replays recorded events of all projects."
          }
        >
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void replay(null);
            }}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-label sm:max-w-md">
              <span className="flex items-center gap-1.5">
                <label htmlFor="replay-cursor" className="text-sm font-medium">
                  Replay from cursor
                </label>
                <InfoHint term="Cursor" label="What is a cursor?">
                  A position in the event log. Leave it blank to replay from the oldest kept event,
                  or paste a cursor (from an export or a snapshot) to replay only what came after.
                </InfoHint>
              </span>
              <Input
                id="replay-cursor"
                className="font-mono"
                value={cursor}
                placeholder="Blank: from the start"
                onChange={(e) => setCursor(e.target.value)}
              />
            </div>
            <Button type="submit" loading={busy} disabled={busy}>
              Replay
            </Button>
            {canContinue && (
              <Button type="button" disabled={busy} onClick={() => void replay(resume)}>
                Continue
              </Button>
            )}
          </form>
          <div className="mt-3 empty:hidden">
            <ActionResult outcome={outcome} />
          </div>
        </Card>
        <Section title="Event log" term="Event stream">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-end gap-3">
                <Field label="Search events" className="w-64 max-w-full">
                  <Input
                    type="search"
                    prefix="search"
                    placeholder="Type, id or text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </Field>
                <EventFilters filter={filter} onChange={setFilter} />
              </div>
              <Button
                onClick={() =>
                  downloadJson(
                    shown,
                    `mimir-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
                  )
                }
              >
                Export JSON ({shown.length})
              </Button>
            </div>
            <p className="text-sm text-muted" aria-live="polite">
              {shown.length} of {all.length} events shown
            </p>
            <EventList
              events={shown}
              tasks={scoped.tasks}
              maxHeight="40rem"
              empty={all.length === 0 ? "No events yet" : "No events match the filters"}
              emptyBody={
                all.length === 0
                  ? "Live events appear as they happen. Replay to load older ones."
                  : "Clear the search or a filter to see more."
              }
            />
          </div>
        </Section>
      </StoreGate>
    </Screen>
  );
}
