// Activity: cached source events for the selected project, newest first by arrival (timestamps
// keep source time). Filters go to Heimdall's event cache; older pages load on demand.
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Id,
  Input,
  LoadMore,
  Page,
  PageHeader,
  Pagination,
  Select,
  Timestamp,
  Toolbar,
  type Column,
} from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import { useHeimdall } from "../app/context";
import { LearnMore } from "../components/app";
import type { R } from "../lib/api";
import { eventSubject, eventTitle } from "../features/events";
import { mergeEventPages } from "../features/workflowState";

const PAGE = 12;
const CATEGORIES = [
  "session",
  "tool",
  "git",
  "test",
  "approval",
  "task",
  "mission",
  "artifact",
];
const ALL = "all";

export function ActivityPage() {
  const { api, state, scope, projectName, open, notify } = useHeimdall();
  const [source, setSource] = useState(ALL),
    [type, setType] = useState(ALL),
    [mission, setMission] = useState(ALL),
    [search, setSearch] = useState(""),
    [rows, setRows] = useState<R[]>([]),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(true),
    [older, setOlder] = useState(false);
  const loadedQuery = useRef("");
  const query = (before?: unknown) =>
    "events?" +
    new URLSearchParams({
      source: source === ALL ? "" : source,
      type: type === ALL ? "" : type,
      missionId: mission === ALL ? "" : mission,
      search,
      ...(before != null ? { before: String(before) } : {}),
    }).toString();
  useEffect(() => {
    // A new event refetches the first page too; only a changed filter starts over.
    const key = [search, source, type, mission].join("\n");
    if (loadedQuery.current !== key) setPage(1);
    let gone = false;
    const timer = setTimeout(
      () =>
        api(query())
          .then((d) => {
            if (gone) return;
            setRows((loaded) =>
              loadedQuery.current === key
                ? mergeEventPages(d.events, loaded)
                : d.events,
            );
            loadedQuery.current = key;
          })
          .catch((e) => notify(e.message, "danger"))
          .finally(() => !gone && setLoading(false)),
      150,
    );
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [search, source, type, mission, state?.events?.[0]?.eventId]);
  const scoped = rows.filter(scope.includes);
  const pageCount = Math.max(1, Math.ceil(scoped.length / PAGE));
  const shown = Math.min(page, pageCount);
  const filtered =
    source !== ALL || type !== ALL || mission !== ALL || !!search;

  const columns: Column<R>[] = [
    {
      key: "time",
      header: "Time",
      width: "150px",
      cell: (e) =>
        e.timestamp ? <Timestamp value={e.timestamp} /> : "Unreported",
    },
    {
      key: "event",
      header: "Event",
      primary: true,
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{eventTitle(e.type)}</span>
          <code className="truncate text-xs text-muted">{String(e.type)}</code>
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      hideOnMobile: true,
      cell: (e) => (
        <Badge tone="neutral">
          {e.source === "mimir"
            ? "Mimir"
            : e.source === "sindri"
              ? "Sindri"
              : String(e.source)}
        </Badge>
      ),
    },
    {
      key: "record",
      header: "Record",
      hideOnMobile: true,
      cell: (e) =>
        eventSubject(e) ? <Id value={String(eventSubject(e))} /> : "—",
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Activity"
        description={
          <>Events from Sindri and Mimir, newest first. {state?.retention}</>
        }
        learnMore={<LearnMore screen="activity" />}
        term="Event stream"
        scope={{ project: projectName }}
      />
      <Card flush>
        <div className="border-b border-line p-card">
          <Toolbar label="Event filters">
            <Input
              aria-label="Search events"
              prefix="search"
              placeholder="Event types, task IDs, tool output…"
              className="w-64 max-w-full"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label="Event source"
              className="w-40"
              value={source}
              onValueChange={setSource}
              options={[
                { value: ALL, label: "All sources" },
                { value: "mimir", label: "Mimir" },
                { value: "sindri", label: "Sindri" },
              ]}
            />
            <Select
              aria-label="Event category"
              className="w-40"
              value={type}
              onValueChange={setType}
              options={[
                { value: ALL, label: "All events" },
                ...CATEGORIES.map((c) => ({
                  value: c,
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                })),
              ]}
            />
            <Select
              aria-label="Mission"
              className="w-56 max-w-full"
              value={mission}
              onValueChange={setMission}
              options={[
                { value: ALL, label: "All missions" },
                ...scope.missions.map((m) => ({
                  value: m.id,
                  label: String(m.objective ?? m.id).slice(0, 80),
                })),
              ]}
            />
          </Toolbar>
        </div>
        <DataTable
          caption="Events"
          className="rounded-none border-0"
          columns={columns}
          rows={scoped.slice((shown - 1) * PAGE, shown * PAGE)}
          rowKey={(e) => e.source + ":" + e.eventId + ":" + e.cacheSequence}
          onRowClick={(e) => open("event", e)}
          rowLabel={(e) => `${eventTitle(e.type)} (${e.type})`}
          loading={loading && !rows.length}
          empty={
            <EmptyState
              compact
              title={
                filtered
                  ? "No events match these filters"
                  : "No recorded activity yet"
              }
              body={
                filtered
                  ? "Clear the filters to see every event."
                  : "Events appear here as the sources publish them."
              }
              action={
                filtered ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSource(ALL);
                      setType(ALL);
                      setMission(ALL);
                      setSearch("");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-card">
          <Pagination
            page={shown}
            pageCount={pageCount}
            onPageChange={setPage}
          />
          {rows.length > 0 && (
            <LoadMore
              hasMore
              loading={older}
              shown={scoped.length}
              onLoadMore={() => {
                setOlder(true);
                void api(query(rows.at(-1)?.cacheSequence))
                  .then((d) =>
                    setRows((loaded) => mergeEventPages(d.events, loaded)),
                  )
                  .catch((e) => notify(e.message, "danger"))
                  .finally(() => setOlder(false));
              }}
            />
          )}
        </div>
      </Card>
    </Page>
  );
}
