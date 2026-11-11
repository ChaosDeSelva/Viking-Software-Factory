import { useState } from "react";
import type { ContextItemView, OpenQuestion, ProvenanceRef, Spec, SpecMeta } from "../api/types.js";
import { Badge, Button, Field, inputClass } from "./ui.js";

export function refLabel(ref: ProvenanceRef, context: ContextItemView[] = []): string {
  if ("intakeId" in ref) return `intake:${ref.intakeId.slice(0, 8)}`;
  if ("knowledgeEntryId" in ref) return `knowledge:${ref.knowledgeEntryId.slice(0, 8)}`;
  if ("taskEvidenceId" in ref) return `evidence:${ref.taskEvidenceId.slice(0, 8)}`;
  const item = context.find(
    (c) => c.ref && "documentId" in c.ref && c.ref.documentId === ref.documentId,
  );
  const name = item?.title ?? `document:${ref.documentId.slice(0, 8)}`;
  return ref.startLine !== undefined
    ? `${name}#L${ref.startLine}-L${ref.endLine ?? ref.startLine}`
    : name;
}

function Sources({ refs, context }: { refs: unknown; context: ContextItemView[] }) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  return (
    <p className="text-xs text-slate-600 dark:text-slate-300">
      Sources: {(refs as ProvenanceRef[]).map((r) => refLabel(r, context)).join(", ")}
    </p>
  );
}

function List({
  title,
  items,
  refs,
  context,
}: {
  title: string;
  items: string[];
  refs: unknown;
  context: ContextItemView[];
}) {
  return (
    <section>
      <h4 className="font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm italic text-slate-600 dark:text-slate-300">None</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <Sources refs={refs} context={context} />
    </section>
  );
}

export function UntrustedBanner({ meta }: { meta: SpecMeta }) {
  if (!meta.untrustedInstructionDetected) return null;
  const sources = [...new Set(meta.injectionFindings.map((f) => f.source))];
  return (
    <div
      role="note"
      aria-label="Untrusted instructions detected"
      className="rounded border-2 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
    >
      <p className="font-semibold">Untrusted instructions detected</p>
      <p>
        Text in {sources.join(", ") || "the input"} looked like instructions to the model. It was
        treated as data, redacted from the spec, and not followed.
      </p>
    </div>
  );
}

const statusTone = (s: Spec["status"]) =>
  s === "approved" ? "ok" : s === "review" ? "warn" : "neutral";

export function SpecView({
  spec,
  meta,
  context = [],
}: {
  spec: Spec;
  meta: SpecMeta | null;
  context?: ContextItemView[];
}) {
  const prov = spec.provenance as Record<string, unknown>;
  const acProv = (prov["acceptanceCriteria"] ?? {}) as Record<string, unknown>;
  const b = spec.body;
  return (
    <article aria-label={`Specification ${spec.title}`} className="space-y-3">
      <header className="space-y-1">
        <h3 className="text-xl font-semibold">{spec.title}</h3>
        <p className="text-sm">
          Version {spec.version} <Badge tone={statusTone(spec.status)}>{spec.status}</Badge>
          {spec.approvedBy ? <> · approved by {spec.approvedBy}</> : null}
        </p>
      </header>
      {meta ? <UntrustedBanner meta={meta} /> : null}
      <section>
        <h4 className="font-semibold">Problem</h4>
        <p className="text-sm">{b.problem}</p>
        <Sources refs={prov["problem"]} context={context} />
      </section>
      <List title="Goals" items={b.goals} refs={prov["goals"]} context={context} />
      <List title="Non-goals" items={b.nonGoals} refs={prov["nonGoals"]} context={context} />
      <List
        title="Constraints"
        items={b.constraints}
        refs={prov["constraints"]}
        context={context}
      />
      <List title="Risks" items={b.risks} refs={prov["risks"]} context={context} />
      <section>
        <h4 className="font-semibold">Assumptions</h4>
        {b.assumptions.length === 0 ? (
          <p className="text-sm italic">None</p>
        ) : (
          <ul className="list-disc pl-5 text-sm">
            {b.assumptions.map((a) => (
              <li key={a.text}>
                {a.text} <Badge tone={a.risk === "high" ? "warn" : "neutral"}>{a.risk} risk</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="font-semibold">Acceptance criteria</h4>
        <ul className="space-y-1 text-sm">
          {b.acceptanceCriteria.map((ac) => (
            <li key={ac.id}>
              <span className="font-mono">{ac.id}</span> {ac.text} <Badge>{ac.verification}</Badge>
              <Sources refs={acProv[ac.id]} context={context} />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="font-semibold">Open questions</h4>
        {b.openQuestions.length === 0 ? (
          <p className="text-sm italic">None</p>
        ) : (
          <ul className="text-sm">
            {b.openQuestions.map((q) => (
              <li key={q.id}>
                <span className="font-mono">{q.id}</span> {q.text}{" "}
                {q.blocking ? <Badge tone="warn">blocking</Badge> : <Badge>non-blocking</Badge>}
                {q.recommendation && (
                  <p className="ml-4">
                    <span className="font-semibold">Recommended:</span> {q.recommendation}
                    {q.rationale && <span className="block italic">{q.rationale}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {meta && meta.unverifiedClaims.length > 0 ? (
        <section>
          <h4 className="font-semibold">Unverified claims (moved to high-risk assumptions)</h4>
          <ul className="list-disc pl-5 text-sm">
            {meta.unverifiedClaims.map((c) => (
              <li key={`${c.section}:${c.text}`}>
                {c.section}: {c.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

export function ContextList({ items }: { items: ContextItemView[] }) {
  if (items.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-semibold">
        Loaded context ({items.length} cited items)
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map((c) => (
          <li key={c.id}>
            <Badge>{c.kind}</Badge> <span className="font-mono text-xs">{c.id.slice(0, 24)}</span>{" "}
            {c.title}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Answer forms for a spec's open questions, blocking or not. Pass `answers`/`onAnswersChange` to
 * keep typed text in the parent (each answer makes a new spec version, which may remount this).
 */
export function OpenQuestions(props: {
  questions: OpenQuestion[];
  busy: boolean;
  onAnswer: (questionId: string, answer: string) => void;
  answers?: Record<string, string>;
  onAnswersChange?: (answers: Record<string, string>) => void;
}) {
  const [local, setLocal] = useState<Record<string, string>>({});
  const answers = props.answers ?? local;
  const setAnswers = props.onAnswersChange ?? setLocal;
  if (props.questions.length === 0) return <p className="text-sm">No open questions remain.</p>;
  return (
    <div className="space-y-3">
      {props.questions.map((q) => {
        const id = `answer-${q.id}`;
        const value = answers[q.id] ?? "";
        return (
          <form
            key={q.id}
            aria-label={`Answer ${q.id}`}
            className={`space-y-2 rounded border p-3 ${
              q.blocking ? "border-amber-400" : "border-slate-300 dark:border-slate-700"
            }`}
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) props.onAnswer(q.id, value.trim());
            }}
          >
            {q.blocking ? <Badge tone="warn">blocking</Badge> : <Badge>non-blocking</Badge>}
            <Field label={`${q.id}: ${q.text}`} id={id}>
              <textarea
                id={id}
                rows={2}
                className={inputClass}
                value={value}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            </Field>
            {q.recommendation && (
              <div className="space-y-1 rounded bg-amber-50 p-2 text-sm text-slate-900 dark:bg-amber-950 dark:text-amber-50">
                <p>
                  <span className="font-semibold">Recommended answer:</span> {q.recommendation}
                </p>
                {q.rationale && <p className="italic">Why: {q.rationale}</p>}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={props.busy}
                  onClick={() => setAnswers({ ...answers, [q.id]: q.recommendation ?? "" })}
                >
                  Use recommendation <span className="sr-only">for {q.id}</span>
                </Button>
              </div>
            )}
            <Button type="submit" disabled={props.busy || !value.trim()}>
              Submit answer <span className="sr-only">to {q.id}</span>
            </Button>
          </form>
        );
      })}
    </div>
  );
}

/** Alias under the old name: it renders non-blocking questions too. */
export const BlockingQuestions = OpenQuestions;
