import { Disclosure, InfoHint } from "@factory/ui";
import { useState, type ReactNode } from "react";
import type { ContextItemView, OpenQuestion, ProvenanceRef, Spec, SpecMeta } from "../api/types.js";
import { Badge, Button, Callout, Field, Status, textareaClass } from "./ui.js";

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
    <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
      Sources: {(refs as ProvenanceRef[]).map((r) => refLabel(r, context)).join(", ")}
    </p>
  );
}

/** One spec section: small heading (with an optional glossary hint) over its content. */
function Part(props: { title: string; term?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        {props.title}
        {props.term ? <InfoHint term={props.term} /> : null}
      </h4>
      {props.children}
    </section>
  );
}

const None = () => <p className="text-sm text-muted">None</p>;

function List({
  title,
  term,
  items,
  refs,
  context,
}: {
  title: string;
  term?: string;
  items: string[];
  refs: unknown;
  context: ContextItemView[];
}) {
  return (
    <Part title={title} {...(term ? { term } : {})}>
      {items.length === 0 ? (
        <None />
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm [overflow-wrap:anywhere]">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <Sources refs={refs} context={context} />
    </Part>
  );
}

export function UntrustedBanner({ meta }: { meta: SpecMeta }) {
  if (!meta.untrustedInstructionDetected) return null;
  const sources = [...new Set(meta.injectionFindings.map((f) => f.source))];
  return (
    <div role="note" aria-label="Untrusted instructions detected">
      <Callout tone="warning" title="Untrusted instructions detected">
        Text in {sources.join(", ") || "the input"} looked like instructions to the model. It was
        treated as data, redacted from the spec, and not followed.{" "}
        <InfoHint term="Flagged source instructions" />
      </Callout>
    </div>
  );
}

/** `headless` drops the title block when the surrounding page already shows it. */
export function SpecView({
  spec,
  meta,
  context = [],
  headless = false,
}: {
  spec: Spec;
  meta: SpecMeta | null;
  context?: ContextItemView[];
  headless?: boolean;
}) {
  const prov = spec.provenance as Record<string, unknown>;
  const acProv = (prov["acceptanceCriteria"] ?? {}) as Record<string, unknown>;
  const b = spec.body;
  return (
    <article aria-label={`Specification ${spec.title}`} className="flex min-w-0 flex-col gap-5">
      {headless ? null : (
        <header className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">{spec.title}</h3>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
            Version {spec.version} <Status value={spec.status} domain="spec" />
            {spec.approvedBy ? <span> · approved by {spec.approvedBy}</span> : null}
          </p>
        </header>
      )}
      {meta ? <UntrustedBanner meta={meta} /> : null}
      <Part title="Problem">
        <p className="text-sm [overflow-wrap:anywhere]">{b.problem}</p>
        <Sources refs={prov["problem"]} context={context} />
      </Part>
      <List title="Goals" items={b.goals} refs={prov["goals"]} context={context} />
      <List title="Non-goals" items={b.nonGoals} refs={prov["nonGoals"]} context={context} />
      <List
        title="Constraints"
        items={b.constraints}
        refs={prov["constraints"]}
        context={context}
      />
      <List title="Risks" term="Risk" items={b.risks} refs={prov["risks"]} context={context} />
      <Part title="Assumptions">
        {b.assumptions.length === 0 ? (
          <None />
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm [overflow-wrap:anywhere]">
            {b.assumptions.map((a) => (
              <li key={a.text}>
                {a.text} <Badge tone={a.risk === "high" ? "warn" : "neutral"}>{a.risk} risk</Badge>
              </li>
            ))}
          </ul>
        )}
      </Part>
      <Part title="Acceptance criteria" term="Acceptance criterion">
        <ul className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
          {b.acceptanceCriteria.map((ac) => (
            <li key={ac.id}>
              <span className="font-mono">{ac.id}</span> {ac.text} <Badge>{ac.verification}</Badge>
              <Sources refs={acProv[ac.id]} context={context} />
            </li>
          ))}
        </ul>
      </Part>
      <Part title="Open questions" term="Open question">
        {b.openQuestions.length === 0 ? (
          <None />
        ) : (
          <ul className="flex flex-col gap-2 text-sm [overflow-wrap:anywhere]">
            {b.openQuestions.map((q) => (
              <li key={q.id}>
                <span className="font-mono">{q.id}</span> {q.text}{" "}
                <Status value={q.blocking ? "blocking" : "non_blocking"} domain="open-question" />
                {q.recommendation && (
                  <p className="mt-1 ml-4">
                    <span className="font-semibold">Recommended:</span> {q.recommendation}
                    {q.rationale && <span className="block text-muted">{q.rationale}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Part>
      {meta && meta.unverifiedClaims.length > 0 ? (
        <Part title="Unverified claims (moved to high-risk assumptions)">
          <ul className="list-disc pl-5 text-sm [overflow-wrap:anywhere]">
            {meta.unverifiedClaims.map((c) => (
              <li key={`${c.section}:${c.text}`}>
                {c.section}: {c.text}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}
    </article>
  );
}

export function ContextList({ items }: { items: ContextItemView[] }) {
  if (items.length === 0) return null;
  return (
    <Disclosure title={`Loaded context (${items.length} cited items)`}>
      <ul className="flex flex-col gap-1.5">
        {items.map((c) => (
          <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge>{c.kind}</Badge>
            <span className="font-mono text-xs text-muted [overflow-wrap:anywhere]">
              {c.id.slice(0, 24)}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{c.title}</span>
          </li>
        ))}
      </ul>
    </Disclosure>
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
  if (props.questions.length === 0)
    return <p className="text-sm text-muted">No open questions remain.</p>;
  return (
    <div className="flex flex-col gap-3">
      {props.questions.map((q) => {
        const id = `answer-${q.id}`;
        const value = answers[q.id] ?? "";
        return (
          <form
            key={q.id}
            aria-label={`Answer ${q.id}`}
            className={`flex min-w-0 flex-col gap-3 rounded-md border p-4 ${
              q.blocking ? "border-warning-border" : "border-line"
            }`}
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) props.onAnswer(q.id, value.trim());
            }}
          >
            <span>
              <Status value={q.blocking ? "blocking" : "non_blocking"} domain="open-question" />
            </span>
            <Field label={`${q.id}: ${q.text}`} id={id}>
              <textarea
                id={id}
                rows={2}
                className={textareaClass}
                value={value}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            </Field>
            {q.recommendation && (
              <div className="flex flex-col items-start gap-2 rounded-md bg-sunken p-3 text-sm">
                <p className="[overflow-wrap:anywhere]">
                  <span className="font-semibold">Recommended answer:</span> {q.recommendation}
                </p>
                {q.rationale && <p className="text-muted">Why: {q.rationale}</p>}
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
            <div>
              <Button
                type="submit"
                disabled={props.busy}
                {...(!props.busy && !value.trim()
                  ? { disabledReason: "Type or accept an answer first." }
                  : {})}
              >
                Submit answer <span className="sr-only">to {q.id}</span>
              </Button>
            </div>
          </form>
        );
      })}
    </div>
  );
}

/** Alias under the old name: it renders non-blocking questions too. */
export const BlockingQuestions = OpenQuestions;
