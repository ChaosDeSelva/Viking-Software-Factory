import { useState } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { Plan, PlanTask } from "../api/delivery-types.js";
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
  const specs = useLoad(
    projectId
      ? async () => (await api.listSpecs(projectId)).filter((s) => s.status === "approved")
      : null,
    [projectId],
  );

  if (!projectId)
    return (
      <Card title="Plans">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  const approved = specs.state.status === "ready" ? specs.state.data : [];
  const chosen = specId || approved[0]?.id || "";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4">
        <Card title="Propose a plan">
          {approved.length === 0 ? (
            <Empty>Approve a spec first; plans are proposed from approved specs.</Empty>
          ) : (
            <form
              aria-label="Propose a plan"
              className="space-y-3"
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
              <Button type="submit" disabled={busy || !chosen}>
                Propose plan
              </Button>
            </form>
          )}
        </Card>
        <Card title="Plans">
          <LoadState state={plans.state} what="plans" onRetry={plans.reload}>
            {(list) =>
              list.length === 0 ? (
                <Empty>No plans yet.</Empty>
              ) : (
                <ul className="space-y-1">
                  {latestPlans(list).map((p) => (
                    <li key={p.lineageId}>
                      <button
                        type="button"
                        aria-pressed={state.planId === p.id}
                        onClick={() => dispatch({ type: "plan/open", planId: p.id })}
                        className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                      >
                        <span className="block">
                          Plan v{p.version} for spec v{p.specVersion}
                        </span>
                        <span className="text-xs">
                          {p.tasks.length} tasks <Badge>{p.status}</Badge>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </LoadState>
        </Card>
      </div>
      <div className="lg:col-span-2">
        {state.planId ? (
          <PlanDetail
            key={state.planId}
            planId={state.planId}
            onChanged={() => setTick((t) => t + 1)}
          />
        ) : (
          <Card title="Plan detail">
            <Empty>Select a plan to see its task graph, harnesses and dry-run order.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function PlanDetail({ planId, onChanged }: { planId: string; onChanged: () => void }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);
  const detail = useLoad(() => api.getPlan(planId), [planId, tick]);
  const dry = useLoad(() => api.dryRunPlan(planId), [planId]);
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

  return (
    <LoadState state={detail.state} what="plan" onRetry={detail.reload}>
      {({ plan, versions }) => (
        <section aria-labelledby="plan-title" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <DetailHeading id="plan-title">Plan v{plan.version}</DetailHeading>
            <Badge tone={plan.status === "approved" ? "ok" : "neutral"}>{plan.status}</Badge>
            <span className="text-sm">for spec v{plan.specVersion}</span>
          </div>
          <nav aria-label="Plan versions">
            <ul className="flex flex-wrap gap-1">
              {versions.map((v) => (
                <li key={v.id}>
                  <Button
                    variant="secondary"
                    aria-current={v.id === plan.id ? "true" : undefined}
                    onClick={() => dispatch({ type: "plan/open", planId: v.id })}
                  >
                    v{v.version} ({v.status})
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
          <p className="text-sm">
            {plan.estimates.taskCount} tasks · about {plan.estimates.wallClockMinutes} min of agent
            time · critical path {plan.estimates.criticalPathMinutes} min ·{" "}
            {plan.estimates.tokens.toLocaleString()} tokens
          </p>
          <div className="flex flex-wrap gap-2">
            {plan.status === "draft" ? (
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
            {plan.status === "review" ? (
              <Button
                disabled={busy || !api.hasApprovalSession()}
                onClick={() =>
                  act(async () => {
                    await api.approvePlan(plan.id);
                    notify(`Approved plan v${plan.version}`);
                  })
                }
              >
                Approve plan
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {plan.status === "review" ? (
              <ApprovalUnlock
                id="plan-approval-code"
                onUnlocked={() => setUnlockTick((n) => n + 1)}
              />
            ) : null}
            {plan.status === "approved" ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  api
                    .createExecution(plan.id)
                    .then(({ execution }) => {
                      dispatch({ type: "execution/open", executionId: execution.id });
                      notify(`Started run ${execution.id}`);
                    }, report)
                    .finally(() => setBusy(false));
                }}
              >
                Execute plan
              </Button>
            ) : null}
          </div>
          <Card title="Dry-run order" headingLevel={3}>
            <LoadState state={dry.state} what="dry run" onRetry={dry.reload}>
              {(d) => (
                <ol aria-label="Dry-run order" className="space-y-1 text-sm">
                  {d.steps.map((s) => (
                    <li key={s.step}>
                      <span className="font-medium">Step {s.step}:</span>{" "}
                      {s.tasks.map((t) => `${t.id} (${t.role})`).join(", ")}
                    </li>
                  ))}
                </ol>
              )}
            </LoadState>
          </Card>
          <Card title="Tasks" headingLevel={3}>
            <div className="space-y-3">
              {plan.tasks.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            </div>
          </Card>
          <PlanBudgets
            key={plan.id}
            plan={plan}
            onSaved={(next) => {
              dispatch({ type: "plan/open", planId: next.id });
              onChanged();
            }}
          />
        </section>
      )}
    </LoadState>
  );
}

function PlanBudgets({ plan, onSaved }: { plan: Plan; onSaved: (plan: Plan) => void }) {
  const api = useApi();
  const report = useReportError();
  const [tasks, setTasks] = useState(plan.tasks);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Task budgets" headingLevel={3}>
      <p className="text-sm">
        Time limits stop local CLI workers. Tokens include cached input and are reported when an
        agent session ends; a token limit blocks further sessions. Saving creates a new draft for
        approval.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          api
            .revisePlan(plan.id, tasks)
            .then(onSaved, report)
            .finally(() => setBusy(false));
        }}
      >
        {tasks.map((task, index) => (
          <div key={task.id} className="grid gap-2 sm:grid-cols-2">
            <Field label={`${task.id}: minutes`} id={`minutes-${task.id}`}>
              <input
                className={inputClass}
                id={`minutes-${task.id}`}
                type="number"
                min="1"
                max="120"
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
            <Field label={`${task.id}: tokens`} id={`tokens-${task.id}`}>
              <input
                className={inputClass}
                id={`tokens-${task.id}`}
                type="number"
                min="1"
                max="1000000"
                value={task.budget.tokens ?? ""}
                onChange={(e) =>
                  setTasks((current) =>
                    current.map((t, i) =>
                      i === index
                        ? { ...t, budget: { ...t.budget, tokens: Number(e.target.value) } }
                        : t,
                    ),
                  )
                }
              />
            </Field>
          </div>
        ))}
        <Button type="submit" disabled={busy}>
          Save budgets as new draft
        </Button>
      </form>
    </Card>
  );
}

function TaskCard({ task }: { task: PlanTask }) {
  const headingId = `task-${task.id}`;
  return (
    <article
      aria-label={`Task ${task.id}`}
      className="space-y-1 rounded border border-slate-300 p-3 text-sm dark:border-slate-700"
    >
      <h4 id={headingId} className="font-semibold">
        {task.id} <Badge>{task.role}</Badge>
      </h4>
      <p>{task.objective}</p>
      <p>
        {task.dependsOn.length ? `Runs after ${task.dependsOn.join(", ")}` : "No dependencies"}
        {task.acceptanceCriteria.length ? ` · covers ${task.acceptanceCriteria.join(", ")}` : null}
      </p>
      <p>
        Harness{" "}
        <span className="font-mono">
          {task.harnessId}@{task.harnessVersion}
        </span>
        {task.skills.length ? ` · skills ${task.skills.join(", ")}` : null}
      </p>
      <details>
        <summary className="cursor-pointer">Why this harness</summary>
        <ul className="ml-4 list-disc">
          {task.selectionRationale.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="font-mono text-xs break-all">Lock {task.harnessLockDigest}</p>
      </details>
    </article>
  );
}
