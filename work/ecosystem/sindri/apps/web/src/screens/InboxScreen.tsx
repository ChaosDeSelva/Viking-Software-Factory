import { useState } from "react";
import type { Intake, IntakeComment } from "../api/types.js";
import { Badge, Button, Card, Empty, Field, LoadState, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

export function SourceBadge({ source }: { source: Intake["source"] }) {
  const label = { manual: "Manual", jira: "Jira", linear: "Linear" }[source];
  return <Badge tone={source === "manual" ? "neutral" : "ok"}>{label}</Badge>;
}

export function InboxScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listIntakes(projectId) : null, [projectId]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ intake: Intake; comments: IntakeComment[] } | null>(
    null,
  );

  if (!projectId)
    return (
      <Card title="Inbox">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const open = (id: string) => run(async () => setSelected(await api.getIntake(id)));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card title="New idea or ticket">
          <form
            aria-label="Manual intake"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const intake = await api.createIntake({ projectId, title: title.trim(), body });
                setTitle("");
                setBody("");
                list.reload();
                dispatch({
                  type: "notice",
                  notice: { kind: "info", text: `Added "${intake.display.title}" to the inbox` },
                });
              });
            }}
          >
            <Field label="Title" id="intake-title">
              <input
                id="intake-title"
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Description" id="intake-body">
              <textarea
                id="intake-body"
                rows={5}
                className={inputClass}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !title.trim()}>
              Add to inbox
            </Button>
          </form>
        </Card>
        <Card title="Import a ticket">
          <form
            aria-label="Import by URL"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const intake = await api.importIntake({ projectId, url: url.trim() });
                setUrl("");
                list.reload();
                dispatch({
                  type: "notice",
                  notice: { kind: "info", text: `Imported "${intake.display.title}"` },
                });
              });
            }}
          >
            <Field
              label="Jira or Linear URL"
              id="intake-url"
              hint="Read-only import. Disabled while local-only mode is on (see Settings)."
            >
              <input
                id="intake-url"
                type="url"
                aria-describedby="intake-url-hint"
                className={inputClass}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !url.trim()}>
              Import
            </Button>
          </form>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Inbox items">
          <LoadState state={list.state} what="the inbox" onRetry={list.reload}>
            {(items) =>
              items.length === 0 ? (
                <Empty>The inbox is empty.</Empty>
              ) : (
                <ul className="space-y-1">
                  {items.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => void open(i.id)}
                        aria-pressed={selected?.intake.id === i.id}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                      >
                        <SourceBadge source={i.source} />
                        <span className="flex-1">{i.display.title}</span>
                        {i.syncState !== "imported" ? (
                          <Badge tone="warn">{i.syncState}</Badge>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </LoadState>
        </Card>
        {selected ? <IntakeDetail {...selected} /> : null}
      </div>
    </div>
  );
}

function IntakeDetail({ intake, comments }: { intake: Intake; comments: IntakeComment[] }) {
  return (
    <Card title="Intake detail">
      <article aria-label="Intake detail" className="space-y-2">
        <h3 className="text-base font-semibold">
          <SourceBadge source={intake.source} /> {intake.display.title}
        </h3>
        {intake.externalUrl ? (
          <p className="text-xs">
            {intake.externalId} · <span className="font-mono">{intake.externalUrl}</span>
          </p>
        ) : null}
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Untrusted text, shown sanitized. It is never executed or treated as instructions.
        </p>
        <pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">
          {intake.display.body || "(no description)"}
        </pre>
        {comments.length > 0 ? (
          <>
            <h4 className="font-medium">Comments</h4>
            <ul className="space-y-1 text-sm">
              {comments.map((c) => (
                <li key={c.id}>
                  <span className="font-medium">{c.display.author}</span> <Badge>{c.origin}</Badge>:{" "}
                  {c.display.body}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </article>
    </Card>
  );
}
