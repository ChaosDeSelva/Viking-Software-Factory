// Documents: the plans and research documents you accepted, kept to read again, download, or
// give to new work as context. Deciding happens on Quality & approvals; this is the library.
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  EmptyState,
  Input,
  Page,
  PageHeader,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useState } from "react";
import { useHeimdall } from "../app/context";
import type { R } from "../lib/api";
import { hrefFor, navigate } from "../lib/router";
import { RunStatus } from "../features/RunStatus";
import { WorkKindBadge } from "../features/WorkForms";
import { decidedDocuments } from "../features/workKinds";
import { scopeOf } from "../features/scope";

const runOf = (d: R) => String(d.executionId ?? d.id);
const titleOf = (d: R) => String(d.work?.title ?? "Untitled document");

/** "local:jacob/web#aps_…" → "jacob". */
const decider = (actor: unknown) =>
  typeof actor === "string"
    ? (/^local:([^/#]+)/.exec(actor)?.[1] ?? actor)
    : "";

/** New work with this document chosen as context, in the document's project. */
export const contextHref = (d: R) =>
  hrefFor("new-work", { project: d.projectId, context: runOf(d) });

export function DocumentsPage() {
  const { state, open } = useHeimdall();
  // A library across every project: a plan made for one project often guides another.
  const scope = scopeOf(state, "all");
  const [search, setSearch] = useState(""),
    [rejected, setRejected] = useState(false);
  const projectOf = (id: unknown) =>
    scope.sindriProjects.find((p) => p.id === id)?.name ?? "";
  const q = search.trim().toLowerCase();
  const rows = decidedDocuments(scope.deliveries, { rejected }).filter(
    (d) =>
      !q ||
      `${titleOf(d)} ${projectOf(d.projectId)}`.toLowerCase().includes(q),
  );
  const read = (d: R) =>
    open("deliveries", { ...d, id: runOf(d), title: titleOf(d) });
  const columns: Column<R>[] = [
    {
      key: "title",
      header: "Document",
      primary: true,
      cell: (d) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="line-clamp-2 font-medium">{titleOf(d)}</span>
          <span className="flex flex-wrap items-center gap-2 text-xs font-normal text-muted">
            <WorkKindBadge kind={d.work?.kind} />
            {projectOf(d.projectId)}
          </span>
        </span>
      ),
    },
    {
      key: "decision",
      header: "Decision",
      cell: (d) => (
        <span className="flex flex-col gap-1">
          <RunStatus execution={{ id: runOf(d) }} deliveries={scope.deliveries} />
          {d.work?.decidedAt && (
            <span className="text-xs text-muted">
              <Timestamp value={d.work.decidedAt} />
              {decider(d.work.decidedBy) ? ` · ${decider(d.work.decidedBy)}` : ""}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (d) => (
        <span className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => read(d)}>
            Read
          </Button>
          {d.work?.decision === "accepted" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(contextHref(d))}
            >
              Use as context
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Plans and research documents you accepted: read them again, download them, or start new work with them as context."
      />
      <Card
        title="Accepted documents"
        count={rows.length}
        flush
        actions={
          <span className="flex flex-wrap items-center gap-3">
            <Input
              aria-label="Search documents"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Checkbox
              id="documents-rejected"
              label="Show rejected"
              checked={rejected}
              onChange={(e) => setRejected(e.target.checked)}
            />
          </span>
        }
      >
        <DataTable
          caption="Accepted documents"
          columns={columns}
          rows={rows}
          rowKey={runOf}
          onRowClick={read}
          rowLabel={titleOf}
          className="rounded-none border-0"
          empty={
            <EmptyState
              compact
              icon="check"
              title={q ? "No documents match" : "No accepted documents yet"}
              body="Plans and research documents appear here once you accept them on Quality & approvals."
            />
          }
        />
      </Card>
    </Page>
  );
}
