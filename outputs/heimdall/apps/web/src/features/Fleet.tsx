// Fleet: Mimir's workers, the agent harnesses on this Mac and the supervisor registry. Global (it
// covers every project). Polls every 5 s; every control is an operator command through propose().
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Cluster,
  CodeBlock,
  DataTable,
  Disclosure,
  EmptyState,
  Field,
  Grid,
  GridItem,
  InfoHint,
  Input,
  Page,
  PageHeader,
  RecordList,
  RecordRow,
  Select,
  Stack,
  Textarea,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import { AccessCallout } from "./AccessCallout";

type Worker = {
  id: string;
  capacity: number;
  active: number;
  draining: boolean;
  health: { ok: boolean; detail?: string };
  capabilities: { runtime: string; agentKinds: string[] } | null;
  sessions: { sessionId: string; state: string }[];
};
type Harness = {
  kind: string;
  installed: boolean;
  lifecycleObservation?: string;
  experimental: boolean;
};
type Actor = {
  id: string;
  parent: string | null;
  state: string;
  reason: string | null;
  epoch: number;
  expires: number;
};
type Policy = {
  missionId: string;
  agentKind: "codex" | "claude";
  enabled: boolean;
  maxTurns: number;
  intervalMs: number;
  turns: number;
};
type Detail = {
  policy?: Policy | null;
  supervisor: Actor;
  messages: {
    id: string;
    kind: string;
    state: string;
    body: string;
    result: string | null;
  }[];
  observations: unknown[];
};

const LIFECYCLE: Record<string, string> = {
  automatic_events: "Automatic lifecycle events",
  acp_protocol: "ACP turns and human permission requests",
  session_transcript: "Session transcript lifecycle; vendor acceptance pending",
  turn_end_notification: "Turn-end notifications; busy state unverified",
};
const LOCKED = "Unlock operator controls under Connections first.";
const termHeader = (text: string, term: string) => (
  <span className="inline-flex items-center gap-1">
    {text} <InfoHint term={term} />
  </span>
);

export function FleetPage() {
  const { api, session, propose } = useHeimdall();
  // Fleet commands go to Mimir, so they need the operator unlock but not Sindri pairing.
  const locked = session.operator ? "" : LOCKED;
  const [harnesses, setHarnesses] = useState<Harness[]>([]),
    [workers, setWorkers] = useState<Worker[] | null>(null),
    [actors, setActors] = useState<Actor[]>([]),
    [errors, setErrors] = useState<string[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [parent, setParent] = useState("none"),
    [reason, setReason] = useState(""),
    [sessionId, setSessionId] = useState(""),
    [text, setText] = useState(""),
    [version, setVersion] = useState(0),
    [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let closed = false;
    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const results = await Promise.allSettled([
          api("fleet"),
          api("supervisors"),
          selected
            ? api("supervisors/" + encodeURIComponent(selected))
            : Promise.resolve(null),
          api("harnesses"),
        ]);
        if (closed) return;
        setWorkers(
          results[0].status === "fulfilled"
            ? (results[0].value.workers ?? [])
            : [],
        );
        setActors(
          results[1].status === "fulfilled"
            ? (results[1].value.supervisors ?? [])
            : [],
        );
        if (results[3].status === "fulfilled")
          setHarnesses(results[3].value.harnesses ?? []);
        setDetail(
          results[2].status === "fulfilled"
            ? (results[2].value as Detail | null)
            : null,
        );
        setErrors(
          results
            .filter((r) => r.status === "rejected")
            .map((r) =>
              String((r as PromiseRejectedResult).reason?.message ?? ""),
            ),
        );
        setUpdated(new Date());
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [api, selected, version]);
  // Until the selected supervisor's own record arrives, the previous one's is not shown: its
  // messages and controls would act on the newly selected supervisor.
  const shown = detail?.supervisor.id === selected ? detail : null;
  const refresh = () => setVersion((v) => v + 1);
  const needReason =
    locked ||
    (reason.trim() ? "" : "Enter the hold or reconciliation reason first.");
  const needSession =
    locked || (sessionId ? "" : "Enter the runtime session ID first.");

  const workerColumns: Column<Worker>[] = [
    {
      key: "id",
      header: termHeader("Worker", "Worker"),
      label: "Worker",
      primary: true,
      cell: (w) => <span className="break-all">{w.id}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (w) => (
        <Status
          value={w.health?.ok ? (w.draining ? "paused" : "running") : "unknown"}
          domain="fleet-worker"
          size="sm"
        />
      ),
    },
    {
      key: "runtime",
      header: termHeader("Runtime", "Runtime"),
      label: "Runtime",
      cell: (w) => w.capabilities?.runtime ?? "Backend unobserved",
    },
    {
      key: "slots",
      header: termHeader("Slots", "Slot"),
      label: "Slots",
      align: "right",
      cell: (w) => `${w.active} / ${w.capacity}`,
    },
    {
      key: "kinds",
      header: termHeader("Agent kinds", "Agent kind"),
      label: "Agent kinds",
      cell: (w) => (
        <span className="break-words">
          {w.capabilities?.agentKinds?.join(", ") || "None reported"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      cell: (w) => (
        <Stack gap={2} className="min-w-0">
          <Button
            size="sm"
            disabledReason={locked || undefined}
            onClick={() =>
              propose("fleet.drain", w.id, { draining: !w.draining })
            }
          >
            {w.draining ? "Resume new assignments" : "Drain worker"}
          </Button>
          <Disclosure
            title={`Inspect ${w.sessions?.length ?? 0} session records`}
          >
            <CodeBlock
              code={JSON.stringify(w.sessions ?? [], null, 2)}
              maxHeight="320px"
            />
          </Disclosure>
        </Stack>
      ),
    },
  ];
  const harnessColumns: Column<Harness>[] = [
    {
      key: "kind",
      header: termHeader("Harness", "Harness"),
      label: "Harness",
      primary: true,
      cell: (h) => <span className="break-all">{h.kind}</span>,
    },
    {
      key: "installed",
      header: "On this Mac",
      cell: (h) => (
        <Cluster gap={1}>
          <Badge tone={h.installed ? "forest" : "neutral"}>
            {h.installed ? "Installed" : "Not found"}
          </Badge>
          {h.experimental && <Badge tone="warning">Experimental</Badge>}
        </Cluster>
      ),
    },
    {
      key: "lifecycle",
      header: "Lifecycle observation",
      cell: (h) => (
        <span className="break-words">
          {LIFECYCLE[String(h.lifecycleObservation)] ??
            "Process and terminal observations only"}
        </span>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Fleet"
        description={
          <>
            Worker ownership and capacity, agent harnesses, and durable
            supervisor controls.
          </>
        }
        learnMore={<LearnMore screen="fleet" />}
        term="Fleet"
        scope={{ global: true }}
        meta={updated && <Timestamp value={updated} prefix="Updated" />}
        actions={<Button onClick={refresh}>Refresh observations</Button>}
      />
      <AccessCallout />
      {errors.length > 0 && (
        // One notice for all failed reads; the same refusal from several endpoints says it once.
        <Callout tone="warning" title="Some observations are unavailable">
          {[...new Set(errors)].map((e) => e.replace(/\.?$/, ".")).join(" ")}{" "}
          Unavailable observations do not mean the worker stopped.
        </Callout>
      )}
      <Card
        title="Workers"
        term="Worker"
        description="Draining stops new assignments and preserves running and uncertain sessions."
        count={workers?.length}
        flush
      >
        <DataTable
          caption="Workers"
          columns={workerColumns}
          rows={workers ?? []}
          loading={workers === null}
          rowKey={(w) => w.id}
          layout="stack"
          empty={
            <EmptyState
              compact
              className="m-4"
              title="No workers reported."
              body="Mimir lists its workers once one has started."
              action={
                <Button size="sm" onClick={refresh}>
                  Refresh observations
                </Button>
              }
            />
          }
        />
      </Card>
      <Card
        title="Agent harnesses on this Mac"
        term="Harness"
        description="Executable discovery does not verify login or remote installation. Semantic lifecycle coverage is listed separately from process visibility."
        count={harnesses.length}
        flush
      >
        <DataTable
          caption="Agent harnesses on this Mac"
          columns={harnessColumns}
          rows={harnesses}
          rowKey={(h) => h.kind}
          layout="stack"
          empty={
            <EmptyState
              compact
              className="m-4"
              title="No harness profiles reported."
            />
          }
        />
      </Card>
      <Card
        title="Supervisor registry"
        term="Supervisor"
        description="Supervisors hold durable control messages. They do not infer completion from silence or replace verification."
      >
        <Stack gap={5}>
          <Grid gap={4} className="items-end">
            <GridItem span={5}>
              <Field label="Supervisor ID">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="build-watch"
                />
              </Field>
            </GridItem>
            <GridItem span={4}>
              <Field label="Parent supervisor">
                <Select
                  value={parent}
                  onValueChange={setParent}
                  options={[
                    { value: "none", label: "Primary / no parent" },
                    ...actors.map((a) => ({ value: a.id, label: a.id })),
                  ]}
                />
              </Field>
            </GridItem>
            <GridItem span={3}>
              <Button
                variant="primary"
                className="w-full"
                disabledReason={
                  locked ||
                  (/^[-\w]{1,64}$/.test(name)
                    ? undefined
                    : "Use 1 to 64 letters, digits, '-' or '_' for the supervisor ID.")
                }
                onClick={() =>
                  propose("supervisor.register", name, {
                    id: name,
                    parent: parent === "none" ? null : parent,
                  })
                }
              >
                Register supervisor
              </Button>
            </GridItem>
          </Grid>
          {actors.length ? (
            <div className="overflow-hidden rounded-md border border-line">
              <RecordList label="Supervisors">
                {actors.map((a) => (
                  <RecordRow
                    key={a.id}
                    selected={a.id === selected}
                    title={`${a.id} · ${a.parent ?? "primary"}`}
                    status={
                      <Status
                        value={a.state}
                        domain="supervisor"
                        size="sm"
                        tooltip={false}
                      />
                    }
                    onClick={() => setSelected(a.id)}
                  />
                ))}
              </RecordList>
            </div>
          ) : (
            <EmptyState
              compact
              title="No supervisors registered."
              body="Register one above to queue durable controls for agent sessions."
            />
          )}
        </Stack>
      </Card>
      {shown && (
        <Card
          title={shown.supervisor.id}
          actions={
            <Status value={shown.supervisor.state} domain="supervisor" />
          }
        >
          <Stack gap={5}>
            <Stack gap={1}>
              <p className="text-sm break-words">
                {shown.supervisor.reason ?? "Ready to receive controls"}
              </p>
              <p className="inline-flex flex-wrap items-center gap-1 text-sm text-muted">
                Lease generation <InfoHint term="Lease generation" />{" "}
                {shown.supervisor.epoch} ·{" "}
                {shown.supervisor.expires > Date.now()
                  ? "owner heartbeat current"
                  : "owner lease expired or not acquired"}
              </p>
            </Stack>
            <SupervisorPolicy
              key={selected}
              policy={shown.policy}
              locked={locked}
              onSave={(policy) =>
                propose("supervisor.policy", selected, policy)
              }
            />
            <Field label="Hold or reconciliation reason">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <Cluster gap={2}>
              <Button
                disabledReason={needReason || undefined}
                onClick={() =>
                  propose("supervisor.state", selected, {
                    state: "held",
                    reason,
                  })
                }
              >
                Hold supervisor
              </Button>
              <Button
                disabledReason={locked || undefined}
                onClick={() =>
                  propose("supervisor.state", selected, {
                    state: "ready",
                    reason: null,
                  })
                }
              >
                Resume supervisor
              </Button>
            </Cluster>
            <Grid gap={4}>
              <GridItem span={5}>
                <Field label="Runtime session ID" term="Agent session">
                  <Input
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                  />
                </Field>
              </GridItem>
              <GridItem span={7}>
                <Field label="Instruction">
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </Field>
              </GridItem>
            </Grid>
            <Cluster gap={2}>
              <Button
                disabledReason={needSession || undefined}
                onClick={() =>
                  propose("supervisor.message", selected, {
                    id: crypto.randomUUID(),
                    control: { kind: "observe", sessionId },
                  })
                }
              >
                Queue observation
              </Button>
              <Button
                disabledReason={
                  needSession ||
                  (text.trim() ? undefined : "Write the instruction first.")
                }
                onClick={() =>
                  propose("supervisor.message", selected, {
                    id: crypto.randomUUID(),
                    control: { kind: "input", sessionId, text },
                  })
                }
              >
                Queue instruction
              </Button>
              <Button
                disabledReason={needSession || undefined}
                onClick={() =>
                  propose("supervisor.message", selected, {
                    id: crypto.randomUUID(),
                    control: { kind: "stop", sessionId, mode: "soft" },
                  })
                }
              >
                Queue graceful stop
              </Button>
            </Cluster>
            {shown.messages.length > 0 && (
              <ul
                aria-label="Control messages"
                className="flex flex-col divide-y divide-line border-y border-line"
              >
                {shown.messages.map((m) => (
                  <li key={m.id} className="flex min-w-0 flex-col gap-3 py-4">
                    <Cluster gap={2} justify="between">
                      <strong className="text-sm break-all">{m.kind}</strong>
                      <Status
                        value={m.state}
                        domain="supervisor-message"
                        size="sm"
                      />
                    </Cluster>
                    <p className="text-sm break-words">
                      {m.result ?? "Awaiting dispatch"}
                    </p>
                    <Disclosure title="Message details">
                      <CodeBlock code={m.body} maxHeight="320px" />
                    </Disclosure>
                    {m.state === "awaiting_approval" && (
                      <Stack gap={3}>
                        <p className="text-sm">
                          Model-proposed input is paused. Inspect the session
                          and message before authorizing it.
                        </p>
                        <CodeBlock code={m.body} maxHeight="320px" />
                        <Cluster gap={2}>
                          <Button
                            disabledReason={needReason || undefined}
                            onClick={() =>
                              propose("supervisor.authorize", selected, {
                                messageId: m.id,
                                approved: true,
                                reason,
                              })
                            }
                          >
                            Authorize instruction
                          </Button>
                          <Button
                            disabledReason={needReason || undefined}
                            onClick={() =>
                              propose("supervisor.authorize", selected, {
                                messageId: m.id,
                                approved: false,
                                reason,
                              })
                            }
                          >
                            Reject instruction
                          </Button>
                        </Cluster>
                      </Stack>
                    )}
                    {m.state === "uncertain" && (
                      <Cluster gap={2}>
                        <Button
                          disabledReason={needReason || undefined}
                          onClick={() =>
                            propose("supervisor.resolve", selected, {
                              messageId: m.id,
                              outcome: "done",
                              reason,
                            })
                          }
                        >
                          Confirm observed completion
                        </Button>
                        <Button
                          disabledReason={needReason || undefined}
                          onClick={() =>
                            propose("supervisor.resolve", selected, {
                              messageId: m.id,
                              outcome: "failed",
                              reason,
                            })
                          }
                        >
                          Confirm failure
                        </Button>
                      </Cluster>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Disclosure title="Ownership and control history">
              <CodeBlock
                code={JSON.stringify(shown.observations, null, 2)}
                maxHeight="420px"
              />
            </Disclosure>
          </Stack>
        </Card>
      )}
    </Page>
  );
}

function SupervisorPolicy({
  policy,
  locked,
  onSave,
}: {
  policy?: Policy | null | undefined;
  /** The access reason, or "" when the session may act. */
  locked: string;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [mission, setMission] = useState(policy?.missionId ?? "");
  const [agent, setAgent] = useState<string>(policy?.agentKind ?? "codex");
  const [limit, setLimit] = useState(String(policy?.maxTurns ?? 10));
  const [interval, setIntervalValue] = useState(
    String((policy?.intervalMs ?? 60000) / 1000),
  );
  const valid =
    !!mission.trim() &&
    Number.isInteger(Number(limit)) &&
    Number(limit) >= 1 &&
    Number(limit) <= 100 &&
    Number(interval) >= 30 &&
    Number(interval) <= 3600;
  // Once turns were used, the mission and harness are fixed: the saved ones are sent again.
  const fixed = !!policy?.turns;
  const save = (active: boolean) =>
    onSave({
      missionId: fixed ? policy!.missionId : mission.trim(),
      agentKind: fixed ? policy!.agentKind : agent,
      enabled: active,
      maxTurns: Number(limit),
      intervalMs: Number(interval) * 1000,
    });
  return (
    <Disclosure title="Autonomous mission supervision">
      <Stack gap={4}>
        <p className="text-sm text-muted">
          Use your local Codex or Claude authentication to inspect this mission
          and queue scoped controls. Model-proposed input requires operator
          authorization. Model turns may incur provider charges. Permissions and
          verification still require their existing checks.
        </p>
        <Cluster gap={2}>
          <Badge tone={policy?.enabled ? "forest" : "neutral"}>
            {policy?.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <span className="text-sm">
            {policy?.turns ?? 0} turns used of{" "}
            {policy?.maxTurns ?? Number(limit)} total
          </span>
        </Cluster>
        <Grid gap={4}>
          <GridItem span={6}>
            <Field label="Mission ID" term="Mission">
              <Input
                value={mission}
                disabled={!!locked || fixed}
                onChange={(e) => setMission(e.target.value)}
              />
            </Field>
          </GridItem>
          <GridItem span={6}>
            <Field label="Decision harness" term="Harness">
              <Select
                value={agent}
                disabled={!!locked || fixed}
                onValueChange={setAgent}
                options={[
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude Code" },
                ]}
              />
            </Field>
          </GridItem>
          <GridItem span={6}>
            <Field label="Total model turn budget">
              <Input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </Field>
          </GridItem>
          <GridItem span={6}>
            <Field label="Observation interval in seconds">
              <Input
                type="number"
                min={30}
                max={3600}
                value={interval}
                onChange={(e) => setIntervalValue(e.target.value)}
              />
            </Field>
          </GridItem>
        </Grid>
        <Cluster gap={2}>
          <Button
            disabledReason={
              locked ||
              (valid
                ? undefined
                : "Enter a mission ID, a turn budget from 1 to 100 and an interval from 30 to 3600 seconds.")
            }
            onClick={() => save(true)}
          >
            Enable bounded supervision
          </Button>
          <Button
            disabledReason={
              locked || (policy ? undefined : "No supervision policy is set.")
            }
            onClick={() =>
              onSave({
                missionId: policy!.missionId,
                agentKind: policy!.agentKind,
                enabled: false,
                maxTurns: policy!.maxTurns,
                intervalMs: policy!.intervalMs,
              })
            }
          >
            Disable model turns
          </Button>
        </Cluster>
      </Stack>
    </Disclosure>
  );
}
