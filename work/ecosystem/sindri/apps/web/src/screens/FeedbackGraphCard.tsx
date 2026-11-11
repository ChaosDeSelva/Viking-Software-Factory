import { useState } from "react";
import type { ProjectFeedbackGraph } from "../api/steward-types.js";
import type { Project } from "../api/types.js";
import { Badge, Button, Card, Empty, Field, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const SOURCES: Record<string, { text: string; tone: "ok" | "warn" | "neutral" }> = {
  auto: { text: "Linked automatically", tone: "ok" },
  override: { text: "Linked by override", tone: "ok" },
  none: { text: "Not linked", tone: "warn" },
};

/** Which Feedback Graph project this factory project reads lessons from, and those lessons. */
export function FeedbackGraphCard({ project }: { project: Project }) {
  const api = useApi();
  const loaded = useLoad(() => api.getProjectFeedbackGraph(project.id), [project.id]);
  return (
    <Card title="Feedback Graph">
      <p className="text-sm">
        Lessons from your past feedback to coding agents, read from Feedback Graph (read-only). They
        inform spec drafting, plans and the steward.
      </p>
      {/* Not LoadState: an optional integration failing to load is shown in place, not as an
          assertive alert competing with the screen's own errors. */}
      {loaded.state.status === "loading" ? (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
          Loading Feedback Graph link…
        </p>
      ) : loaded.state.status === "error" ? (
        <div className="space-y-2 rounded border border-red-400 p-3 text-sm dark:border-red-500">
          <p>Could not load the Feedback Graph link: {loaded.state.error}</p>
          <Button variant="secondary" onClick={loaded.reload}>
            Retry <span className="sr-only">Feedback Graph</span>
          </Button>
        </div>
      ) : (
        <FeedbackGraphLink
          projectId={project.id}
          data={loaded.state.data}
          onSaved={(next) => loaded.setState({ status: "ready", data: next })}
        />
      )}
    </Card>
  );
}

function FeedbackGraphLink(props: {
  projectId: string;
  data: ProjectFeedbackGraph;
  onSaved: (d: ProjectFeedbackGraph) => void;
}) {
  const api = useApi();
  const report = useReportError();
  const { dispatch } = useStore();
  const { link, lessons, error } = props.data;
  const [key, setKey] = useState(link.source === "override" ? (link.projectKey ?? "") : "");
  const [busy, setBusy] = useState(false);
  const source = SOURCES[link.source] ?? { text: link.source, tone: "neutral" as const };

  const save = (projectKey: string | null) => {
    setBusy(true);
    api
      .setProjectFeedbackGraph(props.projectId, projectKey)
      .then((next) => {
        props.onSaved(next);
        setKey(next.link.source === "override" ? (next.link.projectKey ?? "") : "");
        dispatch({
          type: "notice",
          notice: {
            kind: "info",
            text: projectKey === null ? "Using the automatic match" : "Feedback Graph link saved",
          },
        });
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3">
      <p className="text-sm">
        <Badge tone={source.tone}>{source.text}</Badge>{" "}
        {link.projectKey ? (
          <>
            Project key <span className="font-mono">{link.projectKey}</span>
          </>
        ) : (
          "No Feedback Graph project matches this repository."
        )}
      </p>
      {error ? (
        <p className="rounded border border-amber-500 p-2 text-sm">
          Feedback Graph could not be read: {error}
        </p>
      ) : null}
      <form
        aria-label="Feedback Graph override"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) save(key.trim());
        }}
      >
        <Field
          label="Override project key"
          id="fg-override"
          hint="Use this when the automatic match by repository path is wrong or missing."
        >
          <input
            id="fg-override"
            aria-describedby="fg-override-hint"
            className={`${inputClass} font-mono`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy || !key.trim()}>
          Save override
        </Button>
        {link.source === "override" ? (
          <Button variant="secondary" disabled={busy} onClick={() => save(null)}>
            Use automatic
          </Button>
        ) : null}
      </form>
      <h3 className="font-semibold">Lessons</h3>
      {lessons.length === 0 ? (
        <Empty>
          {link.projectKey
            ? "No approved lessons for this project yet."
            : "No lessons: not linked."}
        </Empty>
      ) : (
        <ul className="space-y-2" aria-label="Feedback Graph lessons">
          {lessons.map((l) => (
            <li
              key={l.id}
              className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700"
            >
              <p className="font-medium">{l.title || l.id}</p>
              <p className="whitespace-pre-wrap">{l.rule}</p>
              {l.appliesWhen ? (
                <p className="text-xs text-slate-600 dark:text-slate-300">When: {l.appliesWhen}</p>
              ) : null}
              {(l.paths ?? []).length > 0 ? (
                <p className="font-mono text-xs">{l.paths.join(", ")}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
