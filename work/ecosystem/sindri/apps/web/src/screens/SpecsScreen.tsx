import {
  Cluster,
  DataTable,
  EmptyState,
  ErrorState,
  InfoHint,
  Page,
  RecordList,
  RecordRow,
  SplitView,
  Stack,
  Tabs,
  Toolbar,
} from "@factory/ui";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError } from "../api/client.js";
import type { Spec, SpecDiff } from "../api/types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { OpenQuestions, SpecView } from "../components/SpecView.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  DetailHeading,
  Field,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";
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

  const header = (
    <ScreenHeader
      screen="specs"
      title="Specs"
      term="Spec"
      description="Versioned specifications: review them, answer open questions, approve, then propose a plan."
      actions={
        <Button
          variant="secondary"
          onClick={() => dispatch({ type: "navigate", view: "director" })}
        >
          Draft in Director
        </Button>
      }
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

  const lineages = list.state.status === "ready" ? latestPerLineage(list.state.data) : [];

  return (
    <Page>
      {header}
      <SplitView
        showDetail={state.specId !== null}
        onBack={() => dispatch({ type: "route", route: { specId: null } })}
        backLabel="All specs"
        list={
          <Card
            title="Specifications"
            headingLevel={2}
            flush
            {...(list.state.status === "ready" ? { count: lineages.length } : {})}
          >
            <LoadState state={list.state} what="specs" onRetry={list.reload}>
              {(specs) =>
                specs.length === 0 ? (
                  <EmptyState
                    compact
                    className="m-4"
                    title="No specs yet."
                    body="Draft one in the Director from an idea or an Inbox item."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => dispatch({ type: "navigate", view: "director" })}
                      >
                        Open Director
                      </Button>
                    }
                  />
                ) : (
                  <RecordList label="Specifications">
                    {lineages.map((s) => (
                      <RecordRow
                        key={s.lineageId}
                        title={s.title}
                        meta={`v${s.version} · ${s.versions} version${s.versions === 1 ? "" : "s"}`}
                        status={<Status value={s.status} domain="spec" tooltip={false} />}
                        selected={state.specId === s.id}
                        onClick={() => dispatch({ type: "spec/open", specId: s.id })}
                      />
                    ))}
                  </RecordList>
                )
              }
            </LoadState>
          </Card>
        }
        detail={
          state.specId ? (
            <SpecDetailPanel
              key={state.specId}
              specId={state.specId}
              answers={answers}
              setAnswers={setAnswers}
              onChanged={() => setListTick((t) => t + 1)}
            />
          ) : (
            <Card>
              <EmptyState
                title="No spec selected"
                body="Select a spec to see its versions, diff and approval state."
                action={
                  lineages[0] ? (
                    <Button
                      onClick={() => dispatch({ type: "spec/open", specId: lineages[0]!.id })}
                    >
                      Open the newest spec
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )
        }
      />
    </Page>
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
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  // Radix tabs report one click twice (mouse down, then focus): fetch the Markdown once.
  const markdownRequested = useRef(false);
  const loadMarkdown = () => {
    markdownRequested.current = true;
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
    <LoadState state={detail.state} what="the spec" onRetry={detail.reload}>
      {({ spec, meta, lineage }) => {
        const latest = Math.max(...lineage.map((l) => l.version));
        const latestId = lineage.find((l) => l.version === latest)?.id;
        const isLatest = spec.version === latest;
        const open = spec.body.openQuestions;
        const blocking = open.filter((q) => q.blocking);
        const typed = answers[spec.lineageId] ?? {};
        const editable = isLatest && (spec.status === "draft" || spec.status === "review");
        const answerable = isLatest && open.length > 0 && spec.status !== "approved";
        const approveBlocked =
          blocking.length > 0
            ? "Answer the blocking open questions first."
            : !api.hasApprovalSession()
              ? APPROVALS_LOCKED
              : meta.untrustedInstructionDetected && !acknowledged
                ? "Confirm you reviewed the flagged instructions first."
                : null;
        // Unanswered questions are the next step, so they open first; otherwise the spec itself.
        const current = tab ?? (answerable ? "questions" : "spec");

        const primary = !isLatest ? null : spec.status === "draft" ? (
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
          <Button
            disabled={busy}
            {...(approveBlocked ? { disabledReason: approveBlocked } : {})}
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
        ) : spec.status === "approved" ? (
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
        ) : null;

        return (
          <section aria-labelledby="spec-title" className="flex min-w-0 flex-col gap-6">
            <Stack gap={3}>
              <Cluster gap={3} justify="between" align="start">
                <Cluster gap={3} className="min-w-0">
                  <DetailHeading id="spec-title">{spec.title}</DetailHeading>
                  <Status value={spec.status} domain="spec" size="md" />
                </Cluster>
                <Cluster gap={2}>
                  {editable && !editing ? (
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  ) : null}
                  {primary}
                </Cluster>
              </Cluster>
              <p className="text-sm text-muted">
                Version {spec.version} of {latest}
                {spec.approvedBy ? ` · approved by ${spec.approvedBy}` : ""} · created{" "}
                <Timestamp value={spec.createdAt} />
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-sm font-medium">
                  Versions <InfoHint term="Spec version" />
                </span>
                <nav aria-label="Versions">
                  <ul className="flex flex-wrap gap-1">
                    {lineage.map((v) => (
                      <li key={v.id}>
                        <Button
                          size="sm"
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
              </div>
            </Stack>

            {!isLatest ? (
              <Callout
                tone="info"
                action={
                  latestId ? (
                    <Button
                      variant="secondary"
                      onClick={() => dispatch({ type: "spec/open", specId: latestId })}
                    >
                      Open v{latest}
                    </Button>
                  ) : undefined
                }
              >
                This is not the latest version; only v{latest} can be submitted or approved.
              </Callout>
            ) : spec.status !== "draft" && spec.status !== "review" ? (
              <p className="text-sm text-muted">This version is {spec.status}.</p>
            ) : null}

            {isLatest && spec.status === "review" ? (
              <Stack gap={3}>
                {blocking.length > 0 ? (
                  <Callout tone="warning">
                    <span id="approve-guard">
                      Approval is blocked: {blocking.length} blocking open question
                      {blocking.length === 1 ? "" : "s"} ({blocking.map((q) => q.id).join(", ")})
                      must be answered first. Answering creates a new draft version.
                    </span>
                  </Callout>
                ) : null}
                <ApprovalUnlock
                  id="spec-approval-code"
                  onUnlocked={() => setUnlockTick((n) => n + 1)}
                />
                {meta.untrustedInstructionDetected ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    I reviewed the flagged instructions in this spec&apos;s sources
                    <InfoHint term="Flagged source instructions" />
                  </label>
                ) : null}
              </Stack>
            ) : null}

            {editable && editing ? (
              <EditSpec
                key={spec.id}
                spec={spec}
                busy={busy}
                onCancel={() => setEditing(false)}
                onSave={(patch) =>
                  void run(async () => {
                    const s = await api.reviseSpec(spec.id, patch);
                    moveTo(s, `Saved your edits as v${s.version}`);
                  })
                }
              />
            ) : null}

            <Tabs
              label="Spec sections"
              value={current}
              onValueChange={(v) => {
                setTab(v);
                if (v === "markdown" && !markdownRequested.current) loadMarkdown();
              }}
              items={[
                {
                  value: "spec",
                  label: "Specification",
                  content: <SpecView spec={spec} meta={meta} headless />,
                },
                ...(answerable
                  ? [
                      {
                        value: "questions",
                        label: "Open questions",
                        count: open.length,
                        content: (
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
                                    Object.entries(all[spec.lineageId] ?? {}).filter(
                                      ([id]) => id !== q,
                                    ),
                                  ),
                                }));
                                moveTo(
                                  out.spec,
                                  `Answered ${q}; spec revised to v${out.spec.version}`,
                                );
                              })
                            }
                          />
                        ),
                      },
                    ]
                  : []),
                ...(lineage.length > 1
                  ? [
                      {
                        value: "compare",
                        label: "Compare versions",
                        content: (
                          <section aria-label="Compare versions" className="flex flex-col gap-4">
                            <Toolbar
                              label="Versions to compare"
                              actions={
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  {...(!from || !to
                                    ? { disabledReason: "Choose both versions first." }
                                    : {})}
                                  onClick={() =>
                                    void run(async () => setDiff(await api.diffSpecs(from, to)))
                                  }
                                >
                                  Compare
                                </Button>
                              }
                            >
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
                            </Toolbar>
                            {diff ? <DiffView diff={diff} /> : null}
                          </section>
                        ),
                      },
                    ]
                  : []),
                {
                  value: "markdown",
                  label: "Rendered Markdown",
                  content:
                    markdownError !== null && markdown === null ? (
                      <ErrorState
                        title={`Could not render the spec: ${markdownError}`}
                        retryLabel="Retry"
                        onRetry={loadMarkdown}
                      />
                    ) : (
                      <pre
                        tabIndex={0}
                        className="max-h-[32rem] overflow-auto rounded-md bg-sunken p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                      >
                        {markdown ?? "Loading…"}
                      </pre>
                    ),
                },
              ]}
            />
          </section>
        );
      }}
    </LoadState>
  );
}

/** A small edit form: saving creates a new draft version (the server never edits in place). */
function EditSpec(props: {
  spec: Spec;
  busy: boolean;
  onSave: (patch: { title: string; body: { problem: string; goals: string[] } }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(props.spec.title);
  const [problem, setProblem] = useState(props.spec.body.problem);
  const [goals, setGoals] = useState(props.spec.body.goals.join("\n"));
  const missing = !title.trim()
    ? "Give the spec a title."
    : !problem.trim()
      ? "Describe the problem."
      : null;
  return (
    <form
      aria-label="Edit specification"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-card"
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
          className={textareaClass}
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
          className={textareaClass}
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
        />
      </Field>
      <Cluster gap={2}>
        <Button
          type="submit"
          disabled={props.busy}
          {...(!props.busy && missing ? { disabledReason: missing } : {})}
        >
          Save as new version
        </Button>
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
      </Cluster>
    </form>
  );
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export function DiffView({ diff }: { diff: SpecDiff }) {
  if (!diff.changed) return <p className="text-sm text-muted">No differences.</p>;
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
    <DataTable
      caption="Differences between versions"
      layout="stack"
      rows={rows.map((r, i) => ({ ...r, key: String(i) }))}
      rowKey={(r) => r.key}
      columns={[
        {
          key: "section",
          header: "Section",
          cell: (r) => <span className="font-mono text-xs">{r.section}</span>,
        },
        {
          key: "kind",
          header: "Change",
          cell: (r) => (
            <Badge tone={r.kind === "added" ? "ok" : r.kind === "removed" ? "danger" : "neutral"}>
              {r.kind}
            </Badge>
          ),
        },
        {
          key: "text",
          header: "Text",
          primary: true,
          cell: (r) => <span className="[overflow-wrap:anywhere]">{r.text}</span>,
        },
      ]}
    />
  );
}
