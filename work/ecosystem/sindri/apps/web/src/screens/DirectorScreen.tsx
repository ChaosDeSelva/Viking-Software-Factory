import { useState } from "react";
import type { ContextItemView, Spec, SpecMeta } from "../api/types.js";
import { BlockingQuestions, ContextList, SpecView } from "../components/SpecView.js";
import { Button, Card, Empty, Field, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

export function DirectorScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const intakes = useLoad(projectId ? () => api.listIntakes(projectId) : null, [projectId]);
  const [request, setRequest] = useState("");
  const [intakeId, setIntakeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    spec: Spec;
    meta: SpecMeta;
    context: ContextItemView[];
  } | null>(null);

  if (!projectId)
    return (
      <Card title="Director">
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

  const draft = () =>
    run(async () => {
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
    });

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

  const blocking = result ? result.spec.body.openQuestions.filter((q) => q.blocking) : [];
  return (
    <div className="space-y-4">
      <Card title="Ask the Director">
        <form
          aria-label="Draft a spec"
          className="space-y-3"
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
              rows={4}
              className={inputClass}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
          </Field>
          <Field label="Inbox item (optional)" id="director-intake">
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
          <Button type="submit" disabled={busy || !request.trim()}>
            {busy && !result ? "Drafting…" : "Draft spec"}
          </Button>
        </form>
      </Card>
      {result ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card title="Draft specification">
              <SpecView spec={result.spec} meta={result.meta} context={result.context} />
              <ContextList items={result.context} />
              <Button
                variant="secondary"
                onClick={() => dispatch({ type: "spec/open", specId: result.spec.id })}
              >
                Open in Specs
              </Button>
            </Card>
          </div>
          <Card title="Blocking questions">
            <BlockingQuestions
              questions={blocking}
              busy={busy}
              onAnswer={(q, a) => void answer(q, a)}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
