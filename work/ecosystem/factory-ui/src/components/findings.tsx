import { useRef, useState, type KeyboardEvent } from "react";
import { Button, Checkbox, Textarea } from "./controls.js";
import { DataTable, Disclosure, type Column } from "./data.js";
import { Badge, EmptyState, type BadgeTone } from "./status.js";

export type Severity = "critical" | "major" | "minor" | "nit" | "info";

export interface Finding {
  id: string;
  severity: Severity | (string & {});
  category?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  message: string;
  suggestion?: string | undefined;
  included?: boolean | undefined;
  placement?: "inline" | "general" | undefined;
}

export interface FindingsTableProps {
  findings: readonly Finding[];
  editable?: boolean | undefined;
  onChange?: ((finding: Finding) => void) | undefined;
  emptyText?: string | undefined;
  caption?: string | undefined;
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "major", "minor", "nit", "info"];

export const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: "danger",
  major: "warning",
  minor: "info",
  nit: "neutral",
  info: "neutral",
};

// Code-review findings use `blocking`, which ranks and reads as critical.
const severityKey = (s: string) => {
  const k = s.trim().toLowerCase();
  return k === "blocking" ? "critical" : k;
};
const severityRank = (s: string) => {
  const i = SEVERITY_ORDER.indexOf(severityKey(s) as Severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

/** `file:line`, `file:line-endLine`, `file`, or "General" for general / file-less findings. */
export function findingLocation(f: Finding): string {
  if (f.placement === "general" || !f.file) return "General";
  if (f.line == null) return f.file;
  return f.endLine != null && f.endLine !== f.line
    ? `${f.file}:${f.line}-${f.endLine}`
    : `${f.file}:${f.line}`;
}

/** Severity (critical first), then general findings, then file and line. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const file = (f: Finding) => (f.placement === "general" ? "" : (f.file ?? ""));
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      file(a).localeCompare(file(b)) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

const excerpt = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function SeverityBadge({ severity }: { severity: string }) {
  const key = severityKey(severity);
  const known = (SEVERITY_ORDER as readonly string[]).includes(key);
  const shown = severity.trim().toLowerCase() || "unknown";
  const label = shown[0]!.toUpperCase() + shown.slice(1);
  return (
    <Badge tone={known ? SEVERITY_TONE[key as Severity] : "neutral"}>
      <span className="sr-only">Severity: </span>
      {label}
    </Badge>
  );
}

/** Review findings with severity, location and message; optionally include/exclude and edit. */
export function FindingsTable({
  findings,
  editable = false,
  onChange,
  emptyText = "No findings.",
  caption = "Findings",
}: FindingsTableProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const rows = sortFindings(findings);

  const close = (id: string) => {
    setEditing(null);
    requestAnimationFrame(() => editButtons.current.get(id)?.focus());
  };
  const save = (f: Finding) => {
    const message = draft.trim();
    if (message && message !== f.message) onChange?.({ ...f, message });
    close(f.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, f: Finding) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(f.id);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save(f);
    }
  };

  const columns: Column<Finding>[] = [
    ...(editable
      ? [
          {
            key: "include",
            header: "Include",
            width: "88px",
            cell: (f: Finding) => (
              <Checkbox
                checked={f.included ?? true}
                onChange={(e) => onChange?.({ ...f, included: e.target.checked })}
                label={<span className="sr-only">{`Include finding: ${excerpt(f.message)}`}</span>}
              />
            ),
          },
        ]
      : []),
    {
      key: "severity",
      header: "Severity",
      width: "104px",
      cell: (f) => <SeverityBadge severity={f.severity} />,
    },
    {
      key: "location",
      header: "Location",
      cell: (f) => (
        <span className="font-mono text-xs [overflow-wrap:anywhere]">{findingLocation(f)}</span>
      ),
    },
    {
      key: "message",
      header: "Finding",
      primary: true,
      cell: (f) =>
        editing === f.id ? (
          <div className="flex w-full min-w-0 flex-col gap-2">
            <Textarea
              aria-label="Finding message"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => onKeyDown(e, f)}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={() => save(f)}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => close(f.id)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <span className="flex min-w-0 flex-col gap-1 font-normal [overflow-wrap:anywhere]">
            {f.included === false ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-muted line-through">{f.message}</span>
                <Badge>Excluded</Badge>
              </span>
            ) : (
              <span>{f.message}</span>
            )}
            {f.category && <span className="text-xs text-muted">{f.category}</span>}
            {f.suggestion && (
              <Disclosure title="Suggestion" className="mt-1">
                <pre className="font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {f.suggestion}
                </pre>
              </Disclosure>
            )}
          </span>
        ),
    },
    ...(editable
      ? [
          {
            key: "actions",
            header: "Actions",
            align: "right" as const,
            cell: (f: Finding) =>
              editing === f.id ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit finding: ${excerpt(f.message)}`}
                  ref={(el: HTMLButtonElement | null) => {
                    if (el) editButtons.current.set(f.id, el);
                    else editButtons.current.delete(f.id);
                  }}
                  onClick={() => {
                    setDraft(f.message);
                    setEditing(f.id);
                  }}
                >
                  Edit
                </Button>
              ),
          },
        ]
      : []),
  ];

  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(f) => f.id}
      layout="stack"
      empty={<EmptyState title={emptyText} compact className="m-4" />}
    />
  );
}
