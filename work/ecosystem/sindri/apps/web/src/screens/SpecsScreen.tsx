import { useState, type Dispatch, type SetStateAction } from "react";
import { ApiError } from "../api/client.js";
import type { Spec, SpecDiff } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { OpenQuestions, SpecView } from "../components/SpecView.js";
import { Badge, Button, Card, Empty, Field, LoadState, inputClass } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

/** Latest version of each lineage, newest lineage first. */
export function latestPerLineage(specs: Spec[]): (Spec & { versions: number })[] {
  const by = new Map<string, Spec[]>();
  for (const s of specs) by.set(s.lineageId, [...(by.get(s.lineageId) ?? []), s]);
  return [...by.values()]
    .map((vs) => {
      const latest = vs.reduce((a, b) => (b.version > a.version ? b : a));
      return { ...latest, versions: vs.length };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function SpecsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const [listTick, setListTick] = useState(0);
  // Typed answers live here, per lineage: each answer opens a new version, which remounts the
  // detail panel, and text typed for the other questions must survive that.
  const [answers, setAnswers] = useState<Record<string, Record<string, string>>>({});
  const list = useLoad(projectId ? () => api.listSpecs(projectId) : null, [projectId, listTick]);

  if (!projectId)
    return (
      <Card title="Specs">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Specifications">
        <LoadState state={list.state} what="specs" onRetry={list.reload}>
          {(specs) =>
            specs.length === 0 ? (
              <Empty>No specs yet. Draft one in the Director.</Empty>
            ) : (
              <ul className="space-y-1">
                {latestPerLineage(specs).map((s) => (
                  <li key={s.lineageId}>
                    <button
                      type="button"
                      aria-pressed={state.specId === s.id}
                      onClick={() => dispatch({ type: "spec/open", specId: s.id })}
                      className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                    >
                      <span className="block">{s.title}</span>
                      <span className="text-xs">
                        v{s.version} · {s.versions} version{s.versions === 1 ? "" : "s"}{" "}
                        <Badge>{s.status}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
      </Card>
      <div className="lg:col-span-2">
        {state.specId ? (
          <SpecDetailPanel
            key={state.specId}
            specId={state.specId}
            answers={answers}
            setAnswers={setAnswers}
            onChanged={() => setListTick((t) => t + 1)}
          />
        ) : (
          <Card title="Spec detail">
            <Empty>Select a spec to see its versions, diff and approval state.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function SpecDetailPanel({
  specId,
  answers,
  setAnswers,
  onChanged,
}: {
  specId: string;
  answers: Record<string, Record<string, string>>;
  setAnswers: Dispatch<SetStateAction<Record<string, Record<string, string>>>>;
  onChanged: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const detail = useLoad(() => api.getSpec(specId), [specId]);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [, setUnlockTick] = useState(0);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const loadMarkdown = () => {
    setMarkdownError(null);
    api.renderSpec(specId).then(setMarkdown, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) report(e);
      setMarkdownError(e instanceof Error ? e.message : String(e));
    });
  };
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [diff, setDiff] = useState<SpecDiff | null>(null);

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
  const moveTo = (spec: Spec, text: string) => {
    dispatch({ type: "spec/open", specId: spec.id });
    dispatch({ type: "notice", notice: { kind: "info", text } });
    onChanged();
    detail.reload();
  };

  return (
    <Card title="Spec detail">
      <LoadState state={detail.state} what="the spec" onRetry={detail.reload}>
        {({ spec, meta, lineage }) => {
          const latest = Math.max(...lineage.map((l) => l.version));
          const isLatest = spec.version === latest;
          const open = spec.body.openQuestions;
          const blocking = open.filter((q) => q.blocking);
          const typed = answers[spec.lineageId] ?? {};
          return (
            <div className="space-y-4">
              <nav aria-label="Versions">
                <h3 className="text-sm font-semibold">Versions</h3>
                <ul className="flex flex-wrap gap-1">
                  {lineage.map((v) => (
                    <li key={v.id}>
                      <Button
                        variant={v.id === spec.id ? "primary" : "secondary"}
                        aria-current={v.id === spec.id ? "true" : undefined}
                        onClick={() => dispatch({ type: "spec/open", specId: v.id })}
                      >
                        v{v.version} ({v.status})
                      </Button>
                    </li>
                  ))}
                </ul>
              </nav>

              <SpecView spec={spec} meta={meta} />

              <section
                aria-label="Review and approval"
                className="space-y-2 rounded border border-slate-300 p-3 dark:border-slate-700"
              >
                <h3 className="font-semibold">Review and approval</h3>
                {!isLatest ? (
                  <p className="text-sm">
                    This is not the latest version; only v{latest} can be submitted or approved.
                  </p>
                ) : spec.status === "draft" ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const s = await api.submitSpec(spec.id);
                        moveTo(s, `Submitted v${s.version} for review`);
                      })
                    }
                  >
                    Submit for review
                  </Button>
                ) : spec.status === "review" ? (
                  <div className="space-y-2">
                    {blocking.length > 0 ? (
                      <p id="approve-guard" className="text-sm">
                        Approval is blocked: {blocking.length} blocking open question
                        {blocking.length === 1 ? "" : "s"} ({blocking.map((q) => q.id).join(", ")})
                        must be answered first. Answering creates a new draft version.
                      </p>
                    ) : null}
                    <ApprovalUnlock
                      id="spec-approval-code"
                      onUnlocked={() => setUnlockTick((n) => n + 1)}
                    />
                    {meta.untrustedInstructionDetected ? (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={acknowledged}
                          onChange={(e) => setAcknowledged(e.target.checked)}
                        />
                        I reviewed the flagged instructions in this spec&apos;s sources
                      </label>
                    ) : null}
                    <Button
                      disabled={
                        busy ||
                        blocking.length > 0 ||
                        !api.hasApprovalSession() ||
                        (meta.untrustedInstructionDetected && !acknowledged)
                      }
                      aria-describedby={blocking.length > 0 ? "approve-guard" : undefined}
                      onClick={() =>
                        void run(async () => {
                          const s = await api.approveSpec(
                            spec.id,
                            meta.untrustedInstructionDetected ? { acknowledgeUntrusted: true } : {},
                          );
                          moveTo(s, `Approved v${s.version}`);
                        })
                      }
                    >
                      Approve
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm">This version is {spec.status}.</p>
                    {spec.status === "approved" ? (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setProposing(true);
                          void run(async () => {
                            const { plan } = await api.proposePlan(spec.id);
                            dispatch({ type: "plan/open", planId: plan.id });
                            dispatch({
                              type: "notice",
                              notice: { kind: "info", text: `Proposed plan v${plan.version}` },
                            });
                          }).finally(() => setProposing(false));
                        }}
                      >
                        {proposing ? "Proposing plan…" : "Propose plan"}
                      </Button>
                    ) : null}
                  </div>
                )}
                {isLatest && (spec.status === "draft" || spec.status === "review") ? (
                  <EditSpec
                    key={spec.id}
                    spec={spec}
                    busy={busy}
                    onSave={(patch) =>
                      void run(async () => {
                        const s = await api.reviseSpec(spec.id, patch);
                        moveTo(s, `Saved your edits as v${s.version}`);
                      })
                    }
                  />
                ) : null}
                {isLatest && open.length > 0 && spec.status !== "approved" ? (
                  <OpenQuestions
                    questions={open}
                    busy={busy}
                    answers={typed}
                    onAnswersChange={(next) =>
                      setAnswers((all) => ({ ...all, [spec.lineageId]: next }))
                    }
                    onAnswer={(q, a) =>
                      void run(async () => {
                        const out = await api.answer(spec.id, q, a);
                        setAnswers((all) => ({
                          ...all,
                          [spec.lineageId]: Object.fromEntries(
                            Object.entries(all[spec.lineageId] ?? {}).filter(([id]) => id !== q),
                          ),
                        }));
                        moveTo(out.spec, `Answered ${q}; spec revised to v${out.spec.version}`);
                      })
                    }
                  />
                ) : null}
              </section>

              {lineage.length > 1 ? (
                <section aria-label="Compare versions" className="space-y-2">
                  <h3 className="font-semibold">Compare versions</h3>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="From" id="diff-from">
                      <select
                        id="diff-from"
                        className={inputClass}
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                      >
                        <option value="">Choose…</option>
                        {lineage.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.version}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="To" id="diff-to">
                      <select
                        id="diff-to"
                        className={inputClass}
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                      >
                        <option value="">Choose…</option>
                        {lineage.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.version}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button
                      variant="secondary"
                      disabled={!from || !to || busy}
                      onClick={() => void run(async () => setDiff(await api.diffSpecs(from, to)))}
                    >
                      Compare
                    </Button>
                  </div>
                  {diff ? <DiffView diff={diff} /> : null}
                </section>
              ) : null}

              <details
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open && markdown === null) loadMarkdown();
                }}
              >
                <summary className="cursor-pointer font-semibold">Rendered Markdown</summary>
                {markdownError !== null && markdown === null ? (
                  <div className="mt-2 space-y-2 text-sm">
                    <p>Could not render the spec: {markdownError}</p>
                    <Button variant="secondary" onClick={loadMarkdown}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
                    {markdown ?? "Loading…"}
                  </pre>
                )}
              </details>
            </div>
          );
        }}
      </LoadState>
    </Card>
  );
}

/** A small edit form: saving creates a new draft version (the server never edits in place). */
function EditSpec(props: {
  spec: Spec;
  busy: boolean;
  onSave: (patch: { title: string; body: { problem: string; goals: string[] } }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(props.spec.title);
  const [problem, setProblem] = useState(props.spec.body.problem);
  const [goals, setGoals] = useState(props.spec.body.goals.join("\n"));
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Edit
      </Button>
    );
  return (
    <form
      aria-label="Edit specification"
      className="space-y-2 rounded border border-slate-300 p-3 dark:border-slate-700"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave({
          title: title.trim(),
          body: {
            problem: problem.trim(),
            goals: goals
              .split("\n")
              .map((g) => g.trim())
              .filter(Boolean),
          },
        });
      }}
    >
      <Field label="Title" id="edit-spec-title">
        <input
          id="edit-spec-title"
          className={inputClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Problem" id="edit-spec-problem">
        <textarea
          id="edit-spec-problem"
          rows={3}
          className={inputClass}
          value={problem}
          onChange={(e) => setProblem(e.target.value)}
        />
      </Field>
      <Field
        label="Goals"
        id="edit-spec-goals"
        hint="One per line. Saving creates a new draft version."
      >
        <textarea
          id="edit-spec-goals"
          aria-describedby="edit-spec-goals-hint"
          rows={4}
          className={inputClass}
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={props.busy || !title.trim() || !problem.trim()}>
          Save as new version
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function DiffView({ diff }: { diff: SpecDiff }) {
  if (!diff.changed) return <p className="text-sm">No differences.</p>;
  const rows: { section: string; kind: "added" | "removed" | "changed"; text: string }[] = [];
  if (diff.title)
    rows.push({ section: "title", kind: "changed", text: `${diff.title.from} → ${diff.title.to}` });
  if (diff.problem)
    rows.push({
      section: "problem",
      kind: "changed",
      text: `${diff.problem.from} → ${diff.problem.to}`,
    });
  for (const key of [
    "goals",
    "nonGoals",
    "constraints",
    "risks",
    "assumptions",
    "acceptanceCriteria",
    "openQuestions",
  ] as const) {
    const d = diff[key] as { added: unknown[]; removed: unknown[]; changed?: unknown[] };
    for (const a of d.added) rows.push({ section: key, kind: "added", text: show(a) });
    for (const r of d.removed) rows.push({ section: key, kind: "removed", text: show(r) });
    for (const c of d.changed ?? []) rows.push({ section: key, kind: "changed", text: show(c) });
  }
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Differences between versions</caption>
      <thead>
        <tr>
          <th scope="col">Section</th>
          <th scope="col">Change</th>
          <th scope="col">Text</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-slate-200 dark:border-slate-700">
            <td className="pr-2 font-mono text-xs">{r.section}</td>
            <td className="pr-2">
              <Badge tone={r.kind === "added" ? "ok" : r.kind === "removed" ? "warn" : "neutral"}>
                {r.kind}
              </Badge>
            </td>
            <td>{r.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
