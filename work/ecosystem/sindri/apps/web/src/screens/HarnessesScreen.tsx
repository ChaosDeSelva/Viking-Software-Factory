import { useState } from "react";
import type { HarnessSummary } from "../api/delivery-types.js";
import {
  Badge,
  Button,
  Card,
  DetailHeading,
  Empty,
  Field,
  LoadState,
  inputClass,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const key = (h: HarnessSummary) => `${h.name}@${h.version}`;

export function HarnessesScreen() {
  const api = useApi();
  const { state } = useStore();
  const projectId = state.projectId;
  const list = useLoad(() => api.listHarnesses(), []);
  const signals = useLoad(projectId ? () => api.repoSignals(projectId) : null, [projectId]);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Harnesses">
        <LoadState state={list.state} what="harnesses" onRetry={list.reload}>
          {({ source, harnesses }) => (
            <div className="space-y-3">
              <p className="text-sm">
                {source === "fake" ? (
                  <>
                    <Badge tone="warn">fixtures</Badge> Fixture harnesses: Brokkr is disabled in
                    Settings, so selections come from Sindri&apos;s built-in fake service.
                  </>
                ) : (
                  <>
                    <Badge tone="ok">{source}</Badge> Harnesses resolved by Brokkr.
                  </>
                )}
              </p>
              {harnesses.length === 0 ? (
                <Empty>No harnesses installed.</Empty>
              ) : (
                <ul className="space-y-1">
                  {harnesses.map((h) => (
                    <li key={key(h)}>
                      <button
                        type="button"
                        aria-pressed={selected === key(h)}
                        onClick={() => setSelected(key(h))}
                        className="w-full rounded px-2 py-1.5 text-left font-mono text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                      >
                        {key(h)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </LoadState>
      </Card>
      <div className="space-y-4 lg:col-span-2">
        {list.state.status === "ready" && selected ? (
          <Manifest harness={list.state.data.harnesses.find((h) => key(h) === selected) ?? null} />
        ) : (
          <Card title="Manifest">
            <Empty>Select a harness to see its task types, skills and checks.</Empty>
          </Card>
        )}
        <ExplainForm projectId={projectId} />
        <Card title="Repository signals">
          {projectId ? (
            <LoadState state={signals.state} what="repository signals" onRetry={signals.reload}>
              {(s) => (
                <section aria-label="Repository signals">
                  <dl className="grid grid-cols-2 gap-1 text-sm">
                    <dt className="font-medium">Package manager</dt>
                    <dd>{s.packageManager ?? "unknown"}</dd>
                    <dt className="font-medium">Frameworks</dt>
                    <dd>{s.frameworks.join(", ") || "none"}</dd>
                    <dt className="font-medium">Test runners</dt>
                    <dd>{s.testRunners.join(", ") || "none"}</dd>
                    <dt className="font-medium">Scripts</dt>
                    <dd>{s.scripts.join(", ") || "none"}</dd>
                  </dl>
                </section>
              )}
            </LoadState>
          ) : (
            <Empty>Select a project to inspect its repository.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

function Manifest({ harness }: { harness: HarnessSummary | null }) {
  if (!harness)
    return (
      <Card title="Manifest">
        <Empty>That harness is no longer installed.</Empty>
      </Card>
    );
  return (
    <section
      aria-label={`Manifest ${key(harness)}`}
      className="space-y-2 rounded-lg border border-slate-300 p-4 text-sm dark:border-slate-700"
    >
      <DetailHeading className="font-mono text-lg font-semibold">{key(harness)}</DetailHeading>
      <p>{harness.description}</p>
      <p>Task types: {harness.taskTypes.join(", ") || "none"}</p>
      <p>Required skills: {harness.skills.required.join(", ") || "none"}</p>
      <p>Optional skills: {harness.skills.optional.join(", ") || "none"}</p>
      <div className="space-y-1">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled aria-describedby="harness-ops-hint">
            Install from a local path
          </Button>
          <Button variant="secondary" disabled aria-describedby="harness-ops-hint">
            Pin this version
          </Button>
          <Button variant="secondary" disabled aria-describedby="harness-ops-hint">
            Verify
          </Button>
        </div>
        <p id="harness-ops-hint" className="text-xs text-slate-600 dark:text-slate-300">
          Install, pin and verify run in Brokkr. Sindri&apos;s Brokkr wiring (S4b) is not built yet,
          so they are unavailable here; the server answers 501 not_supported.
        </p>
      </div>
      <h3 className="font-medium">Checks</h3>
      <ul className="ml-4 list-disc">
        {harness.checks.map((c) => (
          <li key={c.id}>
            {c.id} ({c.required ? "required" : "optional"})
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExplainForm({ projectId }: { projectId: string | null }) {
  const api = useApi();
  const report = useReportError();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [types, setTypes] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Why this harness?">
      <form
        aria-label="Explain harness selection"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          const taskTypes = types
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          api
            .explainHarness({
              ...(projectId ? { projectId } : {}),
              task: {
                id: "explain",
                title,
                description,
                ...(taskTypes.length ? { taskTypes } : {}),
              },
            })
            .then((r) => setLines(r.explanation), report)
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Task title" id="explain-title">
          <input
            id="explain-title"
            className={inputClass}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Task description" id="explain-description">
          <textarea
            id="explain-description"
            className={inputClass}
            required
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Task types (comma separated)" id="explain-types">
          <input
            id="explain-types"
            className={inputClass}
            value={types}
            onChange={(e) => setTypes(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          Explain selection
        </Button>
      </form>
      {lines ? (
        <ul aria-label="Explanation" className="ml-4 list-disc text-sm">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
