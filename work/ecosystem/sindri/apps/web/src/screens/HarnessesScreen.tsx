import { Callout, EmptyState, KeyValue, Page, RecordList, RecordRow, SplitView } from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import type { HarnessSummary } from "../api/delivery-types.js";
import {
  Badge,
  Button,
  DetailHeading,
  Empty,
  Field,
  LoadState,
  ScreenHeader,
  inputClass,
  textareaClass,
  Card,
} from "../components/ui.js";
import { useApi, useLoad, useReportError } from "../store/context.js";

const key = (h: HarnessSummary) => `${h.name}@${h.version}`;
const none = (xs: string[]) => xs.join(", ") || "none";

/**
 * Global: the verification harnesses this machine can use. A project's repository signals and
 * "why this harness" live on Project settings, because they depend on the project.
 */
export function HarnessesScreen() {
  const api = useApi();
  const list = useLoad(() => api.listHarnesses(), [], { live: false });
  const [selected, setSelected] = useState<string | null>(null);
  const harnesses = list.state.status === "ready" ? list.state.data.harnesses : [];
  const current = selected ? (harnesses.find((h) => key(h) === selected) ?? null) : undefined;

  return (
    <Page>
      <ScreenHeader
        screen="harnesses"
        title="Harnesses"
        global
        term="Harness"
        description="The checks and skills an agent's work is verified with. Plans pick one per task from the task type and the repository."
      />
      <LoadState state={list.state} what="harnesses" onRetry={list.reload}>
        {({ source }) => (
          <>
            {source === "fake" ? (
              <Callout tone="warning">
                <Badge tone="warn" tooltip="Built-in sample harnesses, not resolved by Brokkr">
                  fixtures
                </Badge>{" "}
                Fixture harnesses: Brokkr is disabled in Settings, so selections come from
                Sindri&apos;s built-in fake service.
              </Callout>
            ) : (
              <Callout tone="info">
                <Badge tone="ok">{source}</Badge> Harnesses resolved by Brokkr.
              </Callout>
            )}
            <SplitView
              showDetail={Boolean(selected)}
              onBack={() => setSelected(null)}
              backLabel="All harnesses"
              list={
                <Card title="Installed" count={harnesses.length} flush>
                  {harnesses.length === 0 ? (
                    <div className="p-card">
                      <Empty body="Enable Brokkr in Settings, or install harnesses with the Brokkr CLI.">
                        No harnesses installed.
                      </Empty>
                    </div>
                  ) : (
                    <RecordList label="Harnesses">
                      {harnesses.map((h) => (
                        <RecordRow
                          key={key(h)}
                          title={<span className="font-mono">{key(h)}</span>}
                          meta={h.description}
                          selected={selected === key(h)}
                          onClick={() => setSelected(key(h))}
                        />
                      ))}
                    </RecordList>
                  )}
                </Card>
              }
              detail={
                current === undefined ? (
                  <Card>
                    <EmptyState
                      icon="info"
                      title="Select a harness"
                      body="See its task types, skills and checks."
                      {...(harnesses[0]
                        ? {
                            action: (
                              <Button
                                variant="secondary"
                                onClick={() => setSelected(key(harnesses[0]!))}
                              >
                                Open {key(harnesses[0])}
                              </Button>
                            ),
                          }
                        : {})}
                    />
                  </Card>
                ) : (
                  <Manifest harness={current} />
                )
              }
            />
          </>
        )}
      </LoadState>
    </Page>
  );
}

function Manifest({ harness }: { harness: HarnessSummary | null }) {
  if (!harness)
    return (
      <Card title="Manifest">
        <Empty>That harness is no longer installed.</Empty>
      </Card>
    );
  const unavailable =
    "Install, pin and verify run in Brokkr. Sindri's Brokkr wiring is not built yet; the server answers 501 not_supported.";
  return (
    <section
      aria-label={`Manifest ${key(harness)}`}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-card"
    >
      <div className="flex flex-col gap-1">
        <DetailHeading className="text-lg font-semibold break-all">{key(harness)}</DetailHeading>
        <p className="text-sm text-muted">{harness.description}</p>
      </div>
      <KeyValue
        items={[
          { label: "Task types", value: none(harness.taskTypes) },
          { label: "Required skills", value: none(harness.skills.required) },
          { label: "Optional skills", value: none(harness.skills.optional) },
        ]}
      />
      {/* Plain text copies keep the manifest readable as one line (search, screen readers). */}
      <p className="sr-only">
        Task types: {none(harness.taskTypes)}. Required skills: {none(harness.skills.required)}.
        Optional skills: {none(harness.skills.optional)}.
      </p>
      <div className="flex flex-col gap-2">
        <h3 className="text-md font-semibold">Checks</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {harness.checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{c.id}</span>{" "}
              <Badge tone={c.required ? "info" : "neutral"}>
                ({c.required ? "required" : "optional"})
              </Badge>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button variant="secondary" disabledReason={unavailable}>
          Install from a local path
        </Button>
        <Button variant="secondary" disabledReason={unavailable}>
          Pin this version
        </Button>
        <Button variant="secondary" disabledReason={unavailable}>
          Verify
        </Button>
      </div>
    </section>
  );
}

/** The selected project's detected tooling (Project settings). */
export function RepositorySignals({ projectId }: { projectId: string }) {
  const api = useApi();
  const signals = useLoad(() => api.repoSignals(projectId), [projectId], { live: false });
  return (
    <Card
      title="Repository signals"
      term="Repository signals"
      description="What Sindri detected in the repository; harness selection uses it."
    >
      <LoadState state={signals.state} what="repository signals" onRetry={signals.reload}>
        {(s) => (
          <section aria-label="Repository signals">
            <KeyValue
              items={[
                { label: "Package manager", value: s.packageManager ?? "unknown" },
                { label: "Frameworks", value: none(s.frameworks) },
                { label: "Test runners", value: none(s.testRunners) },
                { label: "Scripts", value: none(s.scripts) },
              ]}
            />
          </section>
        )}
      </LoadState>
    </Card>
  );
}

/** Asks which harness a described task would get, for this project's repository. */
export function ExplainForm({ projectId }: { projectId: string | null }) {
  const api = useApi();
  const report = useReportError();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [types, setTypes] = useState("");
  const [lines, setLines] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // An explanation depends on the project's repository; it does not describe another project,
  // even when it answers after the switch.
  const current = useRef(projectId);
  useEffect(() => {
    current.current = projectId;
    setLines(null);
  }, [projectId]);
  return (
    <Card
      title="Why this harness?"
      term="Harness"
      description="Describe a task to see which harness and skills a plan would pick, and why."
    >
      <form
        aria-label="Explain harness selection"
        className="flex flex-col gap-field"
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
            .then((r) => {
              if (current.current === projectId) setLines(r.explanation);
            }, report)
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
            className={textareaClass}
            required
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="Task types (comma separated)"
          id="explain-types"
          info="Optional, e.g. frontend, backend, docs. Without them the description decides."
        >
          <input
            id="explain-types"
            className={inputClass}
            value={types}
            onChange={(e) => setTypes(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" loading={busy}>
            Explain selection
          </Button>
        </div>
      </form>
      {lines ? (
        <ul aria-label="Explanation" className="mt-4 ml-4 list-disc text-sm">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
