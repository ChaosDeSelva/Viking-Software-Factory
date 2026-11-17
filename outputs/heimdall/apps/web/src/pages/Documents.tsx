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
import { actionBlock } from "../features/workflowState";
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
  const { state, open, propose, notify, session } = useHeimdall();
  const files: R[] = state?.sindri?.contextFiles ?? [];
  const uploadWhy = actionBlock("contextFile.upload", undefined, session);
  const upload = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const limit = file.type.startsWith("image/") ? 10 : 1;
      if (file.size > limit * 1024 * 1024) {
        notify(`${file.name} is over ${limit} MB.`, "warning");
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      propose("contextFile.upload", "new", {
        name: file.name,
        mime: file.type,
        contentBase64: btoa(binary),
      });
      // One dialog at a time: the next file waits for this one.
      break;
    }
  };
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
  const fileColumns: Column<R>[] = [
    {
      key: "name",
      header: "File",
      primary: true,
      cell: (f) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium [overflow-wrap:anywhere]">{String(f.name)}</span>
          <span className="text-xs font-normal text-muted">
            {f.kind === "image" ? "Image" : "Markdown"} ·{" "}
            {Math.max(1, Math.round(Number(f.bytes) / 1024)).toLocaleString("en-US")} KB
          </span>
        </span>
      ),
    },
    {
      key: "added",
      header: "Added",
      cell: (f) => (f.createdAt ? <Timestamp value={f.createdAt} /> : null),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      cell: (f) => (
        <span className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              navigate(hrefFor("new-work", { context: `file:${f.id}` }))
            }
          >
            Use as context
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabledReason={actionBlock("contextFile.delete", undefined, session) || undefined}
            onClick={() => propose("contextFile.delete", String(f.id))}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Plans and research you accepted, and files you uploaded: read them again, or start new work with them as context."
      />
      <Card
        title="Uploaded files"
        count={files.length}
        description="Markdown documents and images (screenshots, diagrams, mock-ups) to give new work as context."
        flush
        actions={
          <label
            className={
              uploadWhy
                ? "cursor-not-allowed text-sm text-muted"
                : "inline-flex cursor-pointer items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2 focus-within:outline-2 focus-within:outline-focus"
            }
            title={uploadWhy || undefined}
          >
            Upload a file
            <input
              type="file"
              className="sr-only"
              accept=".md,.markdown,text/markdown,image/png,image/jpeg,image/gif,image/webp"
              disabled={!!uploadWhy}
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        }
      >
        <DataTable
          caption="Uploaded files"
          columns={fileColumns}
          rows={files}
          rowKey={(f) => String(f.id)}
          rowLabel={(f) => String(f.name)}
          className="rounded-none border-0"
          empty={
            <EmptyState
              compact
              icon="plus"
              title="No uploaded files"
              body="Upload a .md file (up to 1 MB) or a PNG, JPEG, GIF or WebP image (up to 10 MB)."
            />
          }
        />
      </Card>
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
              label="Show rejected and replaced"
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
