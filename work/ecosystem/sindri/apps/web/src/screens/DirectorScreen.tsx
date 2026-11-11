import { Cluster, EmptyState, Page } from "@factory/ui";
import { useEffect, useState } from "react";
import type { ContextItemView, Spec, SpecMeta } from "../api/types.js";
import { ContextList, OpenQuestions, SpecView } from "../components/SpecView.js";
import { Button, Card, Field, inputClass, ScreenHeader, textareaClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

export function DirectorScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const intakes = useLoad(projectId ? () => api.listIntakes(projectId) : null, [projectId]);
  // "Draft spec from this" in the Inbox preselects the item; the server needs request text, so
  // it starts as the item's title.
  const seed = state.directorSeed;
  const [request, setRequest] = useState(seed?.request ?? "");
  const [intakeId, setIntakeId] = useState(seed?.intakeId ?? "");
  useEffect(() => {
    if (seed) dispatch({ type: "director/seed-used" });
  }, []);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [result, setResult] = useState<{
    spec: Spec;
    meta: SpecMeta;
    context: ContextItemView[];
  } | null>(null);

  const header = (
    <ScreenHeader
      screen="director"
      title="Director"
      term="Director"
      description="Describe what you want built; the Director drafts a spec that cites project context, then asks what it could not decide."
    />
  );
  if (!projectId)
    return (
      <Page>
        {header}
        <EmptyState
          title="Create or select a project first."
          action={
            <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
              Open Projects
            </Button>
          }
        />
      </Page>
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

  const draft = () => {
    setDrafting(true);
    return run(async () => {
      const out = await api.draft({
        projectId,
        request: request.trim(),
        ...(intakeId ? { intakeId } : {}),
      });
      setResult({ spec: out.spec, meta: out.meta, context: out.context });
      dispatch({
        type: "notice",
        notice: { kind: "info", text: `Drafted "${out.spec.title}" (v${out.spec.version})` },
      });
    }).finally(() => setDrafting(false));
  };

  const answer = (questionId: string, text: string) =>
    run(async () => {
      if (!result) return;
      const out = await api.answer(result.spec.id, questionId, text);
      setResult({ ...result, spec: out.spec, meta: out.meta });
      dispatch({
        type: "notice",
        notice: {
          kind: "info",
          text: `Answered ${questionId}; spec revised to v${out.spec.version}`,
        },
      });
    });

  const open = result ? result.spec.body.openQuestions : [];
  const composer = (
    <Card
      title="Ask the Director"
      term="Director"
      description="One request becomes one draft spec. Link an Inbox item to keep its source."
    >
      <form
        aria-label="Draft a spec"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void draft();
        }}
      >
        <Field
          label="Request"
          id="director-request"
          hint="Describe what you want built. The Director drafts a spec citing project context."
        >
          <textarea
            id="director-request"
            aria-describedby="director-request-hint"
            rows={5}
            className={textareaClass}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
        </Field>
        <Field label="Inbox item (optional)" id="director-intake" term="Intake">
          <select
            id="director-intake"
            className={inputClass}
            value={intakeId}
            onChange={(e) => setIntakeId(e.target.value)}
          >
            <option value="">None (record the request as a new intake)</option>
            {intakes.state.status === "ready"
              ? intakes.state.data.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.display.title}
                  </option>
                ))
              : null}
          </select>
        </Field>
        <Cluster gap={3}>
          <Button
            type="submit"
            disabled={busy}
            {...(!busy && !request.trim()
              ? { disabledReason: "Describe what you want built first." }
              : {})}
          >
            {drafting ? "Drafting…" : "Draft spec"}
          </Button>
        </Cluster>
        <p className="text-xs text-muted">
          Drafting can take several minutes. If you leave this screen, the draft will appear in
          Specs when it is ready.
        </p>
      </form>
    </Card>
  );

  return (
    <Page>
      {header}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <div className="flex min-w-0 flex-col gap-6">
          {result ? (
            <Card
              title="Draft specification"
              term="Spec"
              actions={
                <Button
                  variant="secondary"
                  onClick={() => dispatch({ type: "spec/open", specId: result.spec.id })}
                >
                  Open in Specs
                </Button>
              }
            >
              <SpecView spec={result.spec} meta={result.meta} context={result.context} />
              <ContextList items={result.context} />
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon="guide"
                title={drafting ? "Drafting a spec…" : "No draft yet"}
                body={
                  drafting
                    ? "The Director is reading project context. This can take several minutes."
                    : "Write a request and choose Draft spec. The draft shows here with its sources, and open questions appear beside it."
                }
              />
            </Card>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {composer}
          {result ? (
            <Card title="Open questions" term="Open question" count={open.length}>
              <OpenQuestions questions={open} busy={busy} onAnswer={(q, a) => void answer(q, a)} />
            </Card>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
