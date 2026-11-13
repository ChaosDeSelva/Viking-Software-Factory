import {
  Cluster,
  Disclosure,
  EmptyState,
  InfoHint,
  KeyValue,
  Page,
  RecordList,
  RecordRow,
  SplitView,
  Stack,
  Tabs,
} from "@factory/ui";
import { useState } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { Plan, PlanTask } from "../api/delivery-types.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  DetailHeading,
  Empty,
  Field,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  Timestamp,
} from "../components/ui.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";
import { explainStartError } from "../lib/workErrors.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

/** Latest version of each plan lineage, newest first. */
export function latestPlans(plans: Plan[]): Plan[] {
  const by = new Map<string, Plan>();
  for (const p of plans) {
    const cur = by.get(p.lineageId);
    if (!cur || p.version > cur.version) by.set(p.lineageId, p);
  }
  return [...by.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function PlansScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const [tick, setTick] = useState(0);
  const [specId, setSpecId] = useState("");
  const [busy, setBusy] = useState(false);
  const plans = useLoad(projectId ? () => api.listPlans(projectId) : null, [projectId, tick]);
  // Every spec, for plan titles; only approved ones can be proposed from.
  const specs = useLoad(projectId ? () => api.listSpecs(projectId) : null, [projectId]);

  const header = (
    <ScreenHeader
      screen="plans"
      title="Plans"
      term="Plan"
      description="Task graphs proposed from approved specs: check harnesses, order and budgets, approve, then execute."
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

  const allSpecs = specs.state.status === "ready" ? specs.state.data : [];
  const approved = allSpecs.filter((s) => s.status === "approved");
  const specTitle = (id: string) => allSpecs.find((s) => s.id === id)?.title;
  const specStatus = (id: string) => allSpecs.find((s) => s.id === id)?.status;
  // Only a spec from this project's approved list is ever sent.
  const chosen = approved.some((s) => s.id === specId) ? specId : (approved[0]?.id ?? "");
  const listed = plans.state.status === "ready" ? latestPlans(plans.state.data) : [];

  return (
    <Page>
      {header}
      <SplitView
        showDetail={state.planId !== null}
        onBack={() => dispatch({ type: "route", route: { planId: null } })}
        backLabel="All plans"
        list={
          <Stack gap={4}>
            <Card
              title="Propose a plan"
              term="Plan"
              description="The planner turns an approved spec into tasks with harnesses."
            >
              <LoadState state={specs.state} what="approved specs" onRetry={specs.reload}>
                {() =>
                  approved.length === 0 ? (
                    <Empty
                      action={
                        <Button
                          variant="secondary"
                          onClick={() => dispatch({ type: "navigate", view: "specs" })}
                        >
                          Open Specs
                        </Button>
                      }
                    >
                      Approve a spec first; plans are proposed from approved specs.
                    </Empty>
                  ) : (
                    <form
                      aria-label="Propose a plan"
                      className="flex flex-col gap-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setBusy(true);
                        api
                          .proposePlan(chosen)
                          .then(({ plan }) => {
                            dispatch({ type: "plan/open", planId: plan.id });
                            dispatch({
                              type: "notice",
                              notice: { kind: "info", text: `Proposed plan v${plan.version}` },
                            });
                            setTick((t) => t + 1);
                          }, report)
                          .finally(() => setBusy(false));
                      }}
                    >
                      <Field label="Approved spec" id="plan-spec">
                        <select
                          id="plan-spec"
                          className={inputClass}
                          value={chosen}
                          onChange={(e) => setSpecId(e.target.value)}
                        >
                          {approved.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title} (v{s.version})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div>
                        <Button type="submit" disabled={busy || !chosen}>
                          {busy ? "Proposing plan…" : "Propose plan"}
                        </Button>
                      </div>
                    </form>
                  )
                }
              </LoadState>
            </Card>
            <Card
              title="Plans"
              headingLevel={2}
              flush
              {...(plans.state.status === "ready" ? { count: listed.length } : {})}
            >
              <LoadState state={plans.state} what="plans" onRetry={plans.reload}>
                {(list) =>
                  list.length === 0 ? (
                    <EmptyState
                      compact
                      className="m-4"
                      title="No plans yet."
                      body="Propose one from an approved spec above."
                    />
                  ) : (
                    <RecordList label="Plans">
                      {listed.map((p) => (
                        <RecordRow
                          key={p.lineageId}
                          title={specTitle(p.specId) ?? `Plan v${p.version}`}
                          meta={`Plan v${p.version} for spec v${p.specVersion} · ${p.tasks.length} tasks`}
                          status={<Status value={p.status} domain="plan" tooltip={false} />}
                          selected={state.planId === p.id}
                          onClick={() => dispatch({ type: "plan/open", planId: p.id })}
                        />
                      ))}
                    </RecordList>
                  )
                }
              </LoadState>
            </Card>
          </Stack>
        }
        detail={
          state.planId ? (
            <PlanDetail
              key={state.planId}
              planId={state.planId}
              specTitle={specTitle}
              specStatus={specStatus}
              onChanged={() => setTick((t) => t + 1)}
            />
          ) : (
            <Card>
              <EmptyState
                title="No plan selected"
                body="Select a plan to see its task graph, harnesses and dry-run order."
                action={
                  listed[0] ? (
                    <Button onClick={() => dispatch({ type: "plan/open", planId: listed[0]!.id })}>
                      Open the newest plan
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

function PlanDetail({
  planId,
  specTitle,
  specStatus,
  onChanged,
}: {
  planId: string;
  specTitle: (specId: string) => string | undefined;
  /** Undefined until the specs load; a replaced spec's plan cannot be approved or run. */
  specStatus: (specId: string) => string | undefined;
  onChanged: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [tab, setTab] = useState("tasks");
  const [, setUnlockTick] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const detail = useLoad(() => api.getPlan(planId), [planId, tick]);
  const dry = useLoad(() => api.dryRunPlan(planId), [planId], { live: false });
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    fn()
      .then(() => {
        setTick((t) => t + 1);
        onChanged();
      }, report)
      .finally(() => setBusy(false));
  };
  const locked = !api.hasApprovalSession();

  return (
    <LoadState state={detail.state} what="plan" onRetry={detail.reload}>
      {({ plan, versions }) => {
        const latest = Math.max(plan.version, ...versions.map((v) => v.version));
        const latestId = versions.find((v) => v.version === latest)?.id;
        // Submitting, approving and revising act on the latest version only.
        const isLatest = plan.version === latest;
        const specState = specStatus(plan.specId);
        const specReplaced =
          specState !== undefined && specState !== "approved"
            ? `Its spec v${plan.specVersion} is now ${specState}; propose a plan from the approved spec.`
            : null;
        return (
          <section aria-labelledby="plan-title" className="flex min-w-0 flex-col gap-6">
            <Stack gap={3}>
              <Cluster gap={3} justify="between" align="start">
                <Cluster gap={3} className="min-w-0">
                  <DetailHeading id="plan-title">Plan v{plan.version}</DetailHeading>
                  <Status value={plan.status} domain="plan" size="md" />
                </Cluster>
                <Cluster gap={2}>
                  {isLatest && plan.status === "draft" ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          await api.submitPlan(plan.id);
                          notify(`Submitted plan v${plan.version} for review`);
                        })
                      }
                    >
                      Submit for review
                    </Button>
                  ) : null}
                  {isLatest && plan.status === "review" ? (
                    <Button
                      disabled={busy}
                      {...(specReplaced
                        ? { disabledReason: specReplaced }
                        : locked
                          ? { disabledReason: APPROVALS_LOCKED }
                          : plan.untrustedInstructionDetected && !acknowledged
                            ? {
                                disabledReason:
                                  "Confirm you reviewed the flagged instructions first.",
                              }
                            : {})}
                      onClick={() =>
                        act(async () => {
                          await api.approvePlan(
                            plan.id,
                            plan.untrustedInstructionDetected ? { acknowledgeUntrusted: true } : {},
                          );
                          notify(`Approved plan v${plan.version}`);
                        })
                      }
                    >
                      Approve plan
                    </Button>
                  ) : null}
                  {plan.status === "approved" ? (
                    <Button
                      disabled={busy}
                      {...(specReplaced ? { disabledReason: specReplaced } : {})}
                      onClick={() => {
                        setBusy(true);
                        setExecuting(true);
                        api
                          .createExecution(plan.id)
                          .then(
                            ({ execution }) => {
                              dispatch({ type: "execution/open", executionId: execution.id });
                              notify(`Started a run of plan v${plan.version}`);
                            },
                            (e: unknown) => report(explainStartError(e)),
                          )
                          .finally(() => {
                            setBusy(false);
                            setExecuting(false);
                          });
                      }}
                    >
                      {executing ? "Starting run…" : "Execute plan"}
                    </Button>
                  ) : null}
                </Cluster>
              </Cluster>
              <p className="text-sm text-muted [overflow-wrap:anywhere]">
                For spec v{plan.specVersion}
                {specTitle(plan.specId) ? ` · ${specTitle(plan.specId)}` : ""} · proposed{" "}
                <Timestamp value={plan.createdAt} />
              </p>
              <nav aria-label="Plan versions">
                <ul className="flex flex-wrap gap-1">
                  {versions.map((v) => (
                    <li key={v.id}>
                      <Button
                        size="sm"
                        variant={v.id === plan.id ? "primary" : "secondary"}
                        aria-current={v.id === plan.id ? "true" : undefined}
                        onClick={() => dispatch({ type: "plan/open", planId: v.id })}
                      >
                        v{v.version} ({v.status})
                      </Button>
                    </li>
                  ))}
                </ul>
              </nav>
              <KeyValue
                items={[
                  { label: "Tasks", term: "Task", value: plan.estimates.taskCount },
                  {
                    label: "Agent time",
                    term: "Task budget",
                    value: `about ${plan.estimates.wallClockMinutes} min`,
                  },
                  {
                    label: "Critical path",
                    term: "Task graph",
                    value: `${plan.estimates.criticalPathMinutes} min`,
                  },
                  { label: "Tokens", value: plan.estimates.tokens.toLocaleString() },
                ]}
              />
              {!isLatest ? (
                <div role="note" aria-label="Not the latest version">
                  <Callout
                    tone="info"
                    action={
                      latestId ? (
                        <Button
                          variant="secondary"
                          onClick={() => dispatch({ type: "plan/open", planId: latestId })}
                        >
                          Open v{latest}
                        </Button>
                      ) : undefined
                    }
                  >
                    This is not the latest version; only v{latest} can be submitted, approved or
                    revised.
                  </Callout>
                </div>
              ) : null}
              {plan.untrustedInstructionDetected ? (
                <div role="note" aria-label="Untrusted instructions detected">
                  <Callout tone="warning" title="Untrusted instructions detected">
                    Text in{" "}
                    {[...new Set((plan.injectionFindings ?? []).map((f) => f.source))].join(", ") ||
                      "the plan's input"}{" "}
                    looked like instructions to the model. It was treated as data and not followed.
                    Check the tasks before approving.{" "}
                    <InfoHint term="Flagged source instructions" />
                  </Callout>
                  {isLatest && plan.status === "review" ? (
                    <label className="mt-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      I reviewed the flagged instructions and this plan&apos;s tasks
                    </label>
                  ) : null}
                </div>
              ) : null}
              {isLatest && plan.status === "review" && locked ? (
                <Callout tone="info" title="Approvals are locked">
                  <ApprovalUnlock
                    id="plan-approval-code"
                    onUnlocked={() => setUnlockTick((n) => n + 1)}
                  />
                </Callout>
              ) : null}
            </Stack>
            <Tabs
              label="Plan sections"
              value={tab}
              onValueChange={setTab}
              items={[
                {
                  value: "tasks",
                  label: "Tasks",
                  count: plan.tasks.length,
                  content: (
                    <div className="flex flex-col gap-3">
                      {plan.tasks.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  ),
                },
                {
                  value: "order",
                  label: "Dry-run order",
                  content: (
                    <Card
                      title="Dry-run order"
                      term="Dry-run order"
                      description="The order tasks would run in; tasks in one step run in parallel."
                    >
                      <LoadState state={dry.state} what="dry run" onRetry={dry.reload}>
                        {(d) => (
                          <ol aria-label="Dry-run order" className="flex flex-col gap-2 text-sm">
                            {d.steps.map((s) => (
                              <li key={s.step} className="[overflow-wrap:anywhere]">
                                <span className="font-medium">Step {s.step}:</span>{" "}
                                {s.tasks.map((t) => `${t.id} (${t.role})`).join(", ")}
                              </li>
                            ))}
                          </ol>
                        )}
                      </LoadState>
                    </Card>
                  ),
                },
                {
                  value: "budgets",
                  label: "Task budgets",
                  content: (
                    <PlanBudgets
                      key={plan.id}
                      plan={plan}
                      {...(isLatest ? {} : { stale: `Only v${latest} can be revised.` })}
                      onSaved={(next) => {
                        dispatch({ type: "plan/open", planId: next.id });
                        notify(`Saved budgets as draft plan v${next.version}`);
                        onChanged();
                      }}
                    />
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

function PlanBudgets({
  plan,
  stale,
  onSaved,
}: {
  plan: Plan;
  /** Why saving cannot work: the server revises the latest version only. */
  stale?: string;
  onSaved: (plan: Plan) => void;
}) {
  const api = useApi();
  const report = useReportError();
  const [tasks, setTasks] = useState(plan.tasks);
  const [busy, setBusy] = useState(false);
  return (
    <Card
      title="Task budgets"
      term="Task budget"
      description="Saving creates a new draft for approval."
    >
      <p className="text-sm text-muted">
        Time limits stop local CLI workers. Tokens include cached input and are reported when an
        agent session ends; a token limit blocks further sessions. Every task needs a token limit:
        the project's token caps always apply. Saving creates a new draft for approval.
      </p>
      <form
        aria-label="Task budgets"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (stale) return;
          // The planner rejects a plan with any task lacking a token limit while caps apply.
          if (tasks.some((t) => t.budget.tokens === undefined)) return;
          setBusy(true);
          api
            .revisePlan(plan.id, tasks)
            .then(onSaved, report)
            .finally(() => setBusy(false));
        }}
      >
        {tasks.map((task, index) => (
          <div key={task.id} className="grid gap-3 sm:grid-cols-2">
            <Field label={`${task.id}: minutes`} id={`minutes-${task.id}`}>
              <input
                className={inputClass}
                id={`minutes-${task.id}`}
                type="number"
                min="1"
                required
                value={task.budget.wallClockMinutes}
                onChange={(e) =>
                  setTasks((current) =>
                    current.map((t, i) =>
                      i === index
                        ? {
                            ...t,
                            budget: { ...t.budget, wallClockMinutes: Number(e.target.value) },
                          }
                        : t,
                    ),
                  )
                }
              />
            </Field>
            <Field
              label={`${task.id}: tokens`}
              id={`tokens-${task.id}`}
              {...(task.budget.tokens === undefined ? { hint: "A token limit is required." } : {})}
            >
              <input
                className={inputClass}
                id={`tokens-${task.id}`}
                type="number"
                min="1"
                required
                {...(task.budget.tokens === undefined
                  ? { "aria-invalid": true, "aria-describedby": `tokens-${task.id}-hint` }
                  : {})}
                value={task.budget.tokens ?? ""}
                onChange={(e) =>
                  setTasks((current) =>
                    current.map((t, i) => {
                      if (i !== index) return t;
                      // An emptied field is unset (required, so saving waits), not a limit of 0.
                      const budget = { ...t.budget };
                      if (e.target.value === "") delete budget.tokens;
                      else budget.tokens = Number(e.target.value);
                      return { ...t, budget };
                    }),
                  )
                }
              />
            </Field>
          </div>
        ))}
        <div>
          <Button type="submit" disabled={busy} {...(stale ? { disabledReason: stale } : {})}>
            Save budgets as new draft
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TaskCard({ task }: { task: PlanTask }) {
  const headingId = `task-${task.id}`;
  return (
    <article
      aria-label={`Task ${task.id}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-4 text-sm [overflow-wrap:anywhere]"
    >
      <h3 id={headingId} className="flex flex-wrap items-center gap-2 font-semibold">
        <span className="font-mono">{task.id}</span> <Badge>{task.role}</Badge>
      </h3>
      <p>{task.objective}</p>
      <p className="text-muted">
        {task.dependsOn.length ? `Runs after ${task.dependsOn.join(", ")}` : "No dependencies"}
        {task.acceptanceCriteria.length ? ` · covers ${task.acceptanceCriteria.join(", ")}` : null}
      </p>
      <p className="flex flex-wrap items-center gap-1">
        Harness <InfoHint term="Harness" />{" "}
        <span className="font-mono">
          {task.harnessId}@{task.harnessVersion}
        </span>
        {task.skills.length ? ` · skills ${task.skills.join(", ")}` : null}
      </p>
      <Disclosure title="Why this harness">
        <ul className="ml-4 list-disc">
          {task.selectionRationale.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="mt-2 font-mono text-xs break-all text-muted">Lock {task.harnessLockDigest}</p>
      </Disclosure>
    </article>
  );
}
