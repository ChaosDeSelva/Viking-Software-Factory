import type { Crew, CrewId, EventEnvelope, MissionId, Task, UsageResponse } from "@mimir/protocol";
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  KeyValue,
  SegmentedControl,
  useToast,
} from "@factory/ui";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { describeError } from "../api/client.js";
import {
  BUDGET_EVENT_TYPES,
  budgetTargets,
  currentPolicy,
  effectiveOnUnknown,
  latestExceeded,
  parseLimit,
  suggestLimit,
  targetKey,
  type BudgetOnUnknown,
  type BudgetTarget,
} from "../lib/budget.js";
import { crewLabel } from "../lib/names.js";
import { loadHistory } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";
import { formatCost, formatTokens } from "./Badges.js";
import { LoadingState } from "./StateViews.js";

/**
 * "Raise budget" for a task blocked by a budget. Shows what was used against which limit (usage
 * from `GET /v1/usage`, limits rebuilt from the mission's budget events), asks for a new token
 * limit and how unknown usage counts (`onUnknown`; a `budget_uncertain` block clears only by
 * allowing it, never by a higher limit) and sends `PATCH /v1/crews/:id/budget` (or the mission
 * budget) with the version it read, so a concurrent change is refused, not lost. A scope without a
 * budget gets one created. The scheduler unblocks the task on its next tick.
 */
export function RaiseBudgetDialog({
  open,
  onOpenChange,
  missionId,
  task,
  crews,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missionId: string;
  /** The blocked task (its crew narrows the choice); absent for a mission-wide raise. */
  task?: Task | undefined;
  crews: readonly Crew[];
}) {
  // Lifted so the dialog ignores Escape and outside clicks while the request is in flight.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      title="Raise budget"
      description="Blocked tasks start again once the limit is above what was used and unknown usage is allowed or measured."
      size="md"
    >
      {/* Mounted only while open, so every opening reads fresh numbers. */}
      {open && (
        <RaiseBudgetForm
          missionId={missionId}
          task={task}
          crews={crews}
          busy={busy}
          setBusy={setBusy}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

function RaiseBudgetForm({
  missionId,
  task,
  crews,
  busy,
  setBusy,
  onDone,
}: {
  missionId: string;
  task?: Task | undefined;
  crews: readonly Crew[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const { client, refresh, reportError } = useStore();
  const toast = useToast();
  const [history, setHistory] = useState<EventEnvelope[] | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<BudgetTarget | null>(null);
  const [text, setText] = useState("");
  const [onUnknownChoice, setOnUnknown] = useState<BudgetOnUnknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Budget events of the mission: limits, versions and which budget ran out.
  useEffect(() => {
    const ctrl = new AbortController();
    setHistory(null);
    setLoadError(null);
    loadHistory(
      client,
      { missionId: missionId as MissionId, types: [...BUDGET_EVENT_TYPES] },
      ctrl.signal,
    ).then(
      (r) => !ctrl.signal.aborted && setHistory(r.events),
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        reportError(e);
        setLoadError(describeError(e).message);
      },
    );
    return () => ctrl.abort();
  }, [client, missionId, reportError, tick]);

  const exceeded = useMemo(() => (history ? latestExceeded(history) : null), [history]);
  const uncertainBlock = task?.blockedReason === "budget_uncertain";
  const { targets, preferred } = useMemo(() => {
    const policyOf = (t: BudgetTarget) => (history ? currentPolicy(history, t) : null);
    return budgetTargets(
      task,
      crews,
      exceeded,
      (t) => policyOf(t) !== null,
      // Only a budget that blocks unknown usage can hold an unknown-usage block.
      (t) => {
        const p = policyOf(t);
        return uncertainBlock && p !== null && effectiveOnUnknown(p) === "block";
      },
    );
  }, [task, crews, exceeded, history, uncertainBlock]);
  const chosen = target ?? preferred;
  const policy = useMemo(
    () => (history && chosen ? currentPolicy(history, chosen) : null),
    [history, chosen],
  );

  // Spend counted against the chosen budget.
  const chosenKey = chosen ? targetKey(chosen) : null;
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setUsage(null);
    const query =
      chosen.kind === "crew"
        ? { crewId: chosen.crewId as CrewId }
        : { missionId: missionId as MissionId };
    client.usage.get(query).then(
      (r) => live && setUsage(r),
      (e: unknown) => {
        if (!live) return;
        reportError(e);
        setLoadError(describeError(e).message);
      },
    );
    return () => {
      live = false;
    };
    // `chosen` is a fresh object each render; its key identifies it.
  }, [client, chosenKey, missionId, reportError, tick]);

  // The limit in force: the stored policy, else what the exceeded event measured against.
  const exceededHere =
    exceeded &&
    chosen &&
    (chosen.kind === "crew" ? exceeded.crewId === chosen.crewId : exceeded.crewId === null)
      ? exceeded
      : null;
  const limitTokens =
    policy?.limitTokens ?? (exceededHere?.unit === "tokens" ? exceededHere.limit : null);
  const usedTokens = usage?.totals.tokens ?? null;

  const creating = history !== null && policy === null;
  // Prefill once the numbers are in (and again after switching budgets). An unknown-usage block
  // with a limit set needs no new limit, so it starts blank (keep).
  useEffect(() => {
    if (usedTokens === null) return;
    setText(
      uncertainBlock && limitTokens !== null ? "" : String(suggestLimit(usedTokens, limitTokens)),
    );
    setOnUnknown(null);
  }, [usedTokens, limitTokens, chosenKey, uncertainBlock]);

  if (loadError)
    return (
      <div className="flex flex-col gap-3">
        <Callout tone="danger" title="Could not read the budget">
          <span role="alert">{loadError}</span>
        </Callout>
        <div>
          <Button size="sm" icon="refresh" onClick={reload}>
            Retry
          </Button>
        </div>
      </div>
    );
  if (!history) return <LoadingState label="budget" lines={2} />;
  if (!chosen)
    return (
      <Callout tone="warning" title="No crew to raise">
        {exceeded?.scope === "project"
          ? "A project-wide budget is exhausted. It is set on the server and cannot be raised here."
          : "This mission has no crew with a budget yet."}
      </Callout>
    );

  const stored = effectiveOnUnknown(policy);
  const onUnknown = onUnknownChoice ?? (uncertainBlock ? "allow" : stored);
  const keepLimit = text.trim() === "" && limitTokens !== null;
  const parsed = keepLimit ? null : parseLimit(text, limitTokens);
  const belowUse = parsed?.ok === true && usedTokens !== null && parsed.value <= usedTokens;
  const submitLabel = creating ? "Create budget" : uncertainBlock ? "Save budget" : "Raise budget";
  const crewName = (id: string) => {
    const c = crews.find((x) => x.id === id);
    return c ? crewLabel(c) : id;
  };
  const scopeName = chosen.kind === "crew" ? crewName(chosen.crewId) : "Mission budget";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (parsed && !parsed.ok) return setError(parsed.error);
    // A new budget states its unknown-usage rule: the server requires it when usage is unreported.
    const sendOnUnknown = creating || onUnknown !== stored;
    if (!parsed && !sendOnUnknown)
      return setError("Enter a new limit or change how unknown usage counts.");
    setError(null);
    setConflict(false);
    setBusy(true);
    const body = {
      ...(parsed ? { limitTokens: parsed.value } : {}),
      ...(sendOnUnknown ? { onUnknown } : {}),
      ...(creating ? { enforce: "hard" as const } : {}),
      ...(policy ? { expectedVersion: policy.version } : {}),
    };
    try {
      if (chosen.kind === "crew") await client.crews.updateBudget(chosen.crewId as CrewId, body);
      else await client.missions.updateBudget(missionId as MissionId, body);
      toast({
        tone: "success",
        title: creating ? "Budget created" : parsed ? "Budget raised" : "Budget saved",
        description: `${scopeName}: ${
          parsed ? `${formatTokens(parsed.value)} tokens` : `limit kept`
        }, unknown usage ${onUnknown === "allow" ? "allowed" : "blocks new work"}. Blocked tasks start again on the next scheduler pass.`,
      });
      void refresh();
      onDone();
    } catch (err) {
      reportError(err);
      const d = describeError(err);
      if (d.code === "conflict") setConflict(true);
      else setError(d.code ? `${d.code}: ${d.message}` : d.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" noValidate>
      {targets.length > 1 && (
        <SegmentedControl
          label="Budget to raise"
          value={targetKey(chosen)}
          onValueChange={(v) => setTarget(targets.find((t) => targetKey(t) === v) ?? null)}
          options={targets.map((t) => ({
            value: targetKey(t),
            label: t.kind === "crew" ? crewName(t.crewId) : "Mission budget",
          }))}
          className="max-w-full flex-wrap"
        />
      )}
      <KeyValue
        items={[
          {
            label: "Budget",
            value: scopeName,
            term: chosen.kind === "crew" ? "Crew budget" : "Task budget",
          },
          {
            label: "Tokens used",
            value:
              usedTokens === null
                ? "Loading…"
                : `${formatTokens(usedTokens)}${usage?.uncertain ? " (at least)" : ""}`,
          },
          {
            label: "Token limit",
            value: limitTokens === null ? "None set" : formatTokens(limitTokens),
            term: "Budget exceeded",
          },
          ...(policy?.limitCost != null
            ? [
                {
                  label: "Cost",
                  value: `${formatCost(usage?.totals.estimatedCost ?? 0)} of ${formatCost(policy.limitCost)}`,
                },
              ]
            : []),
        ]}
      />
      <Field
        label="New token limit"
        hint={
          limitTokens === null
            ? "Counted as fresh input plus output tokens. The cost limit is left as it is."
            : "Counted as fresh input plus output tokens. Leave blank to keep the current limit; the cost limit is left as it is."
        }
        error={error ?? undefined}
        required={limitTokens === null}
      >
        <Input
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          invalid={error !== null}
        />
      </Field>
      <div className="flex flex-col gap-label">
        <SegmentedControl
          label="When usage is unknown"
          value={onUnknown}
          onValueChange={(v) => setOnUnknown(v === "allow" ? "allow" : "block")}
          options={[
            { value: "allow", label: "Allow new work" },
            { value: "block", label: "Block new work" },
          ]}
        />
        <p className="text-sm text-muted">
          {uncertainBlock
            ? "This task is blocked because the agent reported no usage. A higher limit does not change that; allowing unknown usage does."
            : "Applies when an agent reports no usage, so spend cannot be counted against the limit."}
        </p>
      </div>
      {belowUse && (
        <Callout tone="warning">
          That is not above the {formatTokens(usedTokens ?? 0)} tokens already used, so the task
          stays blocked.
        </Callout>
      )}
      {conflict && (
        <Callout
          tone="warning"
          title="The budget changed since you opened this"
          action={
            <Button size="sm" icon="refresh" onClick={reload}>
              Reload the numbers
            </Button>
          }
        >
          <span role="alert">Someone else changed it. Reload the numbers and try again.</span>
        </Callout>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={usedTokens === null}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
