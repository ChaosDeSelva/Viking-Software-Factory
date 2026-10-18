import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CodeBlock,
  Disclosure,
  DisclosureTrigger,
  Field,
  Input,
  Select,
  Option,
  Textarea,
  StatusBadge,
} from "../components/ui";
type Worker = {
  id: string;
  capacity: number;
  active: number;
  draining: boolean;
  health: { ok: boolean; detail?: string };
  capabilities: { runtime: string; agentKinds: string[] } | null;
  sessions: { sessionId: string; state: string }[];
};
type Actor = {
  id: string;
  parent: string | null;
  state: string;
  reason: string | null;
  epoch: number;
  expires: number;
};
type Policy = { missionId: string; agentKind: "codex" | "claude"; enabled: boolean; maxTurns: number; intervalMs: number; turns: number };
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
export function Fleet({
  api,
  enabled,
  propose,
}: {
  api: (path: string) => Promise<any>;
  enabled: boolean;
  propose: (action: string, id: string, body?: Record<string, unknown>) => void;
}) {
  const [harnesses,setHarnesses]=useState<{kind:string;installed:boolean;lifecycleObservation?:string;experimental:boolean}[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]),
    [actors, setActors] = useState<Actor[]>([]),
    [errors, setErrors] = useState<string[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [selected, setSelected] = useState(""),
    [name, setName] = useState(""),
    [parent, setParent] = useState("none"),
    [reason, setReason] = useState(""),
    [session, setSession] = useState(""),
    [text, setText] = useState(""),
    [version, setVersion] = useState(0),
    [updated, setUpdated] = useState("");
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
          results[0].status === "fulfilled" ? results[0].value.workers : [],
        );
        setActors(
          results[1].status === "fulfilled" ? results[1].value.supervisors : [],
        );
        if(results[3].status === "fulfilled") setHarnesses(results[3].value.harnesses);
        setDetail(results[2].status === "fulfilled" ? results[2].value : null);
        setErrors(
          results
            .filter((r) => r.status === "rejected")
            .map((r) => (r as PromiseRejectedResult).reason.message),
        );
        setUpdated(new Date().toLocaleTimeString());
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
  return (
    <div className="grid gap-6 min-w-0 fleet-page">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="muted">
          Worker ownership, capacity and durable supervisor controls. Last
          observed {updated || "—"}.
        </p>
        <Button onClick={() => setVersion((v) => v + 1)}>
          Refresh observations
        </Button>
      </div>
      {errors.map((error, i) => (
        <Card key={i}>
          <p role="status">{error}</p>
          <p className="muted">
            Unavailable observations do not mean the worker stopped.
          </p>
        </Card>
      ))}
      <section className="grid gap-4 md:grid-cols-2">
        {workers.map((worker) => (
          <Card key={worker.id}>
            <div className="flex flex-wrap justify-between gap-3">
              <h2>{worker.id}</h2>
              <StatusBadge
                value={
                  worker.health.ok
                    ? worker.draining
                      ? "paused"
                      : "running"
                    : "unknown"
                }
              />
            </div>
            <p>
              {worker.capabilities?.runtime ?? "Backend unobserved"} ·{" "}
              {worker.active} / {worker.capacity} occupied slots
            </p>
            <p className="muted break-words">
              {worker.capabilities?.agentKinds.join(", ")}
            </p>
            <Button
              disabled={!enabled}
              onClick={() =>
                propose("fleet.drain", worker.id, {
                  draining: !worker.draining,
                })
              }
            >
              {worker.draining ? "Resume new assignments" : "Drain worker"}
            </Button>
            <p className="muted">
              Draining preserves running and uncertain sessions.
            </p>
            <Disclosure>
              <DisclosureTrigger>
                Inspect {worker.sessions.length} session records
              </DisclosureTrigger>
              <CodeBlock>{JSON.stringify(worker.sessions, null, 2)}</CodeBlock>
            </Disclosure>
          </Card>
        ))}
      </section>
      <Card><h2>Agent harnesses on this Mac</h2><p className="muted">Executable discovery does not verify login or remote installation. Semantic lifecycle coverage is listed separately from process visibility.</p>
      <Disclosure><DisclosureTrigger>Inspect {harnesses.length} harness profiles</DisclosureTrigger><div className="grid gap-3 md:grid-cols-2">{harnesses.map(h=><div key={h.kind} className="border border-[var(--line)] rounded-xl p-4 min-w-0"><strong>{h.kind}</strong><p>{h.installed?"Installed":"Not found"}{h.experimental?" · Experimental":""}</p><p className="muted break-words">{h.lifecycleObservation==="automatic_events"?"Automatic lifecycle events":h.lifecycleObservation==="acp_protocol"?"ACP turns and human permission requests":h.lifecycleObservation==="session_transcript"?"Session transcript lifecycle; vendor acceptance pending":h.lifecycleObservation==="turn_end_notification"?"Turn-end notifications; busy state unverified":"Process and terminal observations only"}</p></div>)}</div></Disclosure></Card>
      <Card>
        <h2>Supervisor registry</h2>
        <p className="muted">
          Supervisors hold durable control messages. They do not infer
          completion from silence or replace verification.
        </p>
        <div className="form-action-grid">
          <Field>Supervisor ID
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="build-watch"
            />
          </Field>
          <Field>Parent supervisor
            <Select value={parent} onValueChange={setParent}>
              <Option value="none">Primary / no parent</Option>
              {actors.map((a) => (
                <Option key={a.id} value={a.id}>
                  {a.id}
                </Option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={!enabled || !/^[-\w]{1,64}$/.test(name)}
            onClick={() =>
              propose("supervisor.register", name, {
                id: name,
                parent: parent === "none" ? null : parent,
              })
            }
          >
            Register supervisor
          </Button>
        </div>
        <div className="grid gap-3 mt-5">
          {actors.map((a) => (
            <Button
              key={a.id}
              className="flex flex-wrap justify-between gap-3"
              onClick={() => setSelected(a.id)}
            >
              <span>
                {a.id} · {a.parent ?? "primary"}
              </span>
              <StatusBadge value={a.state} />
            </Button>
          ))}
        </div>
      </Card>
      {detail && (
        <Card>
          <h2>{detail.supervisor.id}</h2>
          <p>{detail.supervisor.reason ?? "Ready to receive controls"}</p>
          <p className="muted">
            Lease generation {detail.supervisor.epoch} ·{" "}
            {detail.supervisor.expires > Date.now()
              ? "owner heartbeat current"
              : "owner lease expired or not acquired"}
          </p>
          <SupervisorPolicy key={selected} policy={detail.policy} enabled={enabled} onSave={(policy) => propose("supervisor.policy", selected, policy)} />
          <Field>Hold or reconciliation reason
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-3 my-4">
            <Button
              disabled={!enabled || !reason.trim()}
              onClick={() =>
                propose("supervisor.state", selected, { state: "held", reason })
              }
            >
              Hold supervisor
            </Button>
            <Button
              disabled={!enabled}
              onClick={() =>
                propose("supervisor.state", selected, {
                  state: "ready",
                  reason: null,
                })
              }
            >
              Resume supervisor
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field>Runtime session ID
              <Input
                value={session}
                onChange={(e) => setSession(e.target.value)}
              />
            </Field>
            <Field>Instruction
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3 my-4">
            <Button
              disabled={!enabled || !session}
              onClick={() =>
                propose("supervisor.message", selected, {
                  id: crypto.randomUUID(),
                  control: { kind: "observe", sessionId: session },
                })
              }
            >
              Queue observation
            </Button>
            <Button
              disabled={!enabled || !session || !text.trim()}
              onClick={() =>
                propose("supervisor.message", selected, {
                  id: crypto.randomUUID(),
                  control: { kind: "input", sessionId: session, text },
                })
              }
            >
              Queue instruction
            </Button>
            <Button
              disabled={!enabled || !session}
              onClick={() =>
                propose("supervisor.message", selected, {
                  id: crypto.randomUUID(),
                  control: { kind: "stop", sessionId: session, mode: "soft" },
                })
              }
            >
              Queue graceful stop
            </Button>
          </div>
          {detail.messages.map((m) => (
            <article
              key={m.id}
              className="border-t border-[var(--line)] py-4 min-w-0"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <strong>{m.kind}</strong>
                <StatusBadge value={m.state} />
              </div>
              <p className="break-words">{m.result ?? "Awaiting dispatch"}</p>
              <Disclosure>
                <DisclosureTrigger>Message details</DisclosureTrigger>
                <CodeBlock>{m.body}</CodeBlock>
              </Disclosure>
              {m.state === "awaiting_approval" && <div className="grid gap-3 mt-3"><p>Model-proposed input is paused. Inspect the session and message before authorizing it.</p><CodeBlock>{m.body}</CodeBlock><div className="flex flex-wrap gap-3"><Button disabled={!enabled||!reason.trim()} onClick={()=>propose("supervisor.authorize",selected,{messageId:m.id,approved:true,reason})}>Authorize instruction</Button><Button disabled={!enabled||!reason.trim()} onClick={()=>propose("supervisor.authorize",selected,{messageId:m.id,approved:false,reason})}>Reject instruction</Button></div></div>}
              {m.state === "uncertain" && (
                <div className="flex gap-3 mt-3">
                  <Button
                    disabled={!enabled || !reason.trim()}
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
                    disabled={!enabled || !reason.trim()}
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
                </div>
              )}
            </article>
          ))}
          <Disclosure>
            <DisclosureTrigger>Ownership and control history</DisclosureTrigger>
            <CodeBlock>
              {JSON.stringify(detail.observations, null, 2)}
            </CodeBlock>
          </Disclosure>
        </Card>
      )}
    </div>
  );
}

function SupervisorPolicy({policy,enabled,onSave}:{policy?: Policy|null;enabled:boolean;onSave:(body:Record<string,unknown>)=>void}) {
 const [mission,setMission]=useState(policy?.missionId??"");
 const [agent,setAgent]=useState(policy?.agentKind??"codex");
 const [limit,setLimit]=useState(String(policy?.maxTurns??10));
 const [interval,setIntervalValue]=useState(String((policy?.intervalMs??60000)/1000));
 const valid=!!mission.trim()&&Number.isInteger(Number(limit))&&Number(limit)>=1&&Number(limit)<=100&&Number(interval)>=30&&Number(interval)<=3600;
 const save=(active:boolean)=>onSave({missionId:policy?.turns?policy.missionId:mission.trim(),agentKind:policy?.turns?policy.agentKind:agent,enabled:active,maxTurns:Number(limit),intervalMs:Number(interval)*1000});
 return <Disclosure><DisclosureTrigger>Autonomous mission supervision</DisclosureTrigger>
 <p className="muted">Use your local Codex or Claude authentication to inspect this mission and queue scoped controls. Model-proposed input requires operator authorization. Model turns may incur provider charges. Permissions and verification still require their existing checks.</p>
 <p>{policy?.enabled?"Enabled":"Disabled"} · {policy?.turns??0} turns used of {policy?.maxTurns??Number(limit)} total</p>
 <div className="grid gap-4 md:grid-cols-2">
 <Field>Mission ID<Input value={mission} disabled={!enabled||!!policy?.turns} onChange={e=>setMission(e.target.value)}/></Field>
 <Field>Decision harness<Select value={agent} disabled={!enabled||!!policy?.turns} onValueChange={v=>setAgent(v as "codex"|"claude")}><Option value="codex">Codex</Option><Option value="claude">Claude Code</Option></Select></Field>
 <Field>Total model turn budget<Input type="number" min={1} max={100} value={limit} onChange={e=>setLimit(e.target.value)}/></Field>
 <Field>Observation interval in seconds<Input type="number" min={30} max={3600} value={interval} onChange={e=>setIntervalValue(e.target.value)}/></Field>
 </div><div className="flex flex-wrap gap-3 my-4"><Button disabled={!enabled||!valid} onClick={()=>save(true)}>Enable bounded supervision</Button><Button disabled={!enabled||!policy} onClick={()=>onSave({missionId:policy!.missionId,agentKind:policy!.agentKind,enabled:false,maxTurns:policy!.maxTurns,intervalMs:policy!.intervalMs})}>Disable model turns</Button></div>
 </Disclosure>;
}
