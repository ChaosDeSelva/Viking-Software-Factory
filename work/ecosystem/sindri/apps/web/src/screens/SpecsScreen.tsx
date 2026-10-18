import { useState } from "react";
import type { Spec, SpecDiff } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { BlockingQuestions, SpecView } from "../components/SpecView.js";
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

function SpecDetailPanel({ specId, onChanged }: { specId: string; onChanged: () => void }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const detail = useLoad(() => api.getSpec(specId), [specId]);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [, setUnlockTick] = useState(0);
  const [markdown, setMarkdown] = useState<string | null>(null);
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
          const blocking = spec.body.openQuestions.filter((q) => q.blocking);
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
                  <p className="text-sm">This version is {spec.status}.</p>
                )}
                {isLatest && blocking.length > 0 && spec.status !== "approved" ? (
                  <BlockingQuestions
                    questions={blocking}
                    busy={busy}
                    onAnswer={(q, a) =>
                      void run(async () => {
                        const out = await api.answer(spec.id, q, a);
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
                  if ((e.target as HTMLDetailsElement).open && markdown === null)
                    void run(async () => setMarkdown(await api.renderSpec(spec.id)));
                }}
              >
                <summary className="cursor-pointer font-semibold">Rendered Markdown</summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
                  {markdown ?? "Loading…"}
                </pre>
              </details>
            </div>
          );
        }}
      </LoadState>
    </Card>
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
