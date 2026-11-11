// Raise budget: the way out of a task Mimir parked as blocked on a budget. The form reads the
// current spend and limits from Mimir's attention list and proposes `budget.raise`, which Heimdall
// sends as PATCH /v1/{crews,missions}/:id/budget (operator unlock required, reason recorded).
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  KeyValue,
  SegmentedControl,
} from "@factory/ui";
import { useEffect, useState } from "react";
import { useHeimdall } from "../app/context";
import type { R } from "../lib/api";
import {
  budgetBlock,
  budgetEntryFor,
  budgetPayload,
  budgetTarget,
  entryScope,
  type BudgetScope,
  type OnUnknown,
} from "./budgetForm";

const n = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const fmt = (v: number | null, unit: "tokens" | "usd") =>
  v === null
    ? "Unlimited"
    : unit === "usd"
      ? `$${v.toFixed(2)}`
      : v.toLocaleString() + " tokens";

export function RaiseBudgetForm({
  task,
  onProposed,
}: {
  task: R;
  onProposed?: () => void;
}) {
  const { api, session, propose, reloadKey } = useHeimdall();
  const uncertainBlock = task.blockedReason === "budget_uncertain";
  const [entry, setEntry] = useState<R | undefined>(undefined),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [tokens, setTokens] = useState(""),
    [cost, setCost] = useState(""),
    // Used only when Mimir names no blocking budget: the operator picks where the change goes.
    [chosenScope, setChosenScope] = useState<BudgetScope>("crew"),
    // Higher limits cannot release a task held because usage is unknown; allowing dispatch can.
    [onUnknown, setOnUnknown] = useState<OnUnknown | "">(
      uncertainBlock ? "allow" : "",
    );
  useEffect(() => {
    let gone = false;
    api("attention")
      .then((d) => {
        if (gone) return;
        const found = budgetEntryFor(d.items ?? [], task);
        setEntry(found);
        // Start from double the current limit: enough to finish in most cases, still bounded.
        if (!uncertainBlock && n(found?.limitTokens) !== null)
          setTokens(String(found!.limitTokens * 2));
        setError("");
      })
      .catch((e) => !gone && setError(e.message))
      .finally(() => !gone && setLoaded(true));
    return () => {
      gone = true;
    };
  }, [task.id, task.crewId, task.blockedReason, reloadKey]);
  const scope = entryScope(entry) ?? chosenScope;
  const target = budgetTarget(task, scope, entry);
  const why = budgetBlock(
    !!session.operator,
    target,
    tokens,
    cost,
    entry,
    onUnknown,
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {uncertainBlock
          ? "Mimir stopped dispatching this task because it cannot measure usage and the budget blocks when usage is unknown. Allowing dispatch when usage is unknown releases it on Mimir's next tick."
          : "Mimir stopped dispatching this task because a budget is used up. A higher limit returns it to ready on Mimir's next tick."}{" "}
        A budget retry does not use up an attempt.
      </p>
      {error && (
        <Callout
          tone="warning"
          title="Mimir's current budget could not be read"
        >
          {error}. You can still choose a budget and set new values.
        </Callout>
      )}
      {entry && (
        <KeyValue
          columns={2}
          items={[
            {
              label: "Budget",
              value: scope === "mission" ? "Mission budget" : "Crew budget",
              term: "Crew budget",
            },
            {
              label: "Spent",
              value: `${n(entry.spentTokens)?.toLocaleString() ?? "—"} tokens · $${(n(entry.spentCost) ?? 0).toFixed(2)}${entry.uncertain ? " (usage partly unknown)" : ""}`,
            },
            {
              label: "Token limit",
              value: fmt(n(entry.limitTokens), "tokens"),
            },
            { label: "Cost limit", value: fmt(n(entry.limitCost), "usd") },
          ]}
        />
      )}
      {loaded && !entry && (
        <>
          {!error && (
            <p className="text-sm text-muted">
              Mimir names no budget holding this task right now. Choose which
              budget to change; Mimir creates it if it does not exist.
            </p>
          )}
          <SegmentedControl
            label="Budget to change"
            value={chosenScope}
            onValueChange={(v) =>
              setChosenScope(v === "mission" ? "mission" : "crew")
            }
            options={[
              { value: "crew", label: "Crew budget" },
              { value: "mission", label: "Mission budget" },
            ]}
          />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="New token limit"
          hint="Whole tokens; leave empty to keep the current limit."
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
          />
        </Field>
        <Field
          label="New cost limit (USD)"
          hint="Leave empty to keep the current limit."
        >
          <Input
            type="number"
            min={0.01}
            step={0.01}
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <SegmentedControl
          label="When usage is unknown"
          value={onUnknown || "keep"}
          onValueChange={(v) =>
            setOnUnknown(v === "allow" || v === "block" ? v : "")
          }
          options={[
            { value: "keep", label: "Keep current" },
            { value: "allow", label: "Allow dispatch" },
            { value: "block", label: "Block dispatch" },
          ]}
        />
        <p className="text-xs text-muted">
          When usage is unknown, Mimir either keeps dispatching or holds tasks.
          A new hard budget needs this choice when the runtime reports no usage.
        </p>
      </div>
      <div>
        <Button
          variant="primary"
          disabledReason={why || undefined}
          onClick={() => {
            propose(
              "budget.raise",
              String(target),
              budgetPayload(scope, tokens, cost, onUnknown, entry),
            );
            onProposed?.();
          }}
        >
          Review budget change
        </Button>
      </div>
    </div>
  );
}

/** "Raise budget" next to a budget-blocked task in a list; the form opens in a dialog. */
export function RaiseBudgetButton({
  task,
  size = "sm",
}: {
  task: R;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        variant="secondary"
        icon="plus"
        onClick={() => setOpen(true)}
      >
        Raise budget
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Raise budget"
        description={String(task.title ?? task.id)}
        size="md"
      >
        <RaiseBudgetForm task={task} onProposed={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
