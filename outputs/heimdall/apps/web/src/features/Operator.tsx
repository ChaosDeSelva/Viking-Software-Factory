import {
  Card,
  Button,
  Field,
  Select,
  Option,
  Disclosure,
  DisclosureTrigger,
  Input,
  CodeBlock,
} from "../components/ui";
import { useEffect, useRef, useState } from "react";
type R = Record<string, any>;
export function Notifications({
  items,
  enabled,
  onRead,
  onInspect,
  onEnable,
}: {
  items: R[];
  enabled: boolean;
  onRead: (id: string) => void;
  onInspect: (k: string, r: R) => void;
  onEnable: () => void;
}) {
  const [filter, setFilter] = useState("unread");
  const [page, setPage] = useState(0);
  const rows = items.filter(
    (n) => filter === "all" || (filter === "unread" ? !n.seen : n.active),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  return (
    <Card className="panel">
      <div className="section-title">
        <h2>Operator notifications</h2>
        <div className="actions">
          <Button onClick={onEnable}>
            {enabled ? "Desktop alerts enabled" : "Enable desktop alerts"}
          </Button>
          <Button disabled={!rows.some(n => !n.seen)} onClick={() => rows.filter(n => !n.seen).forEach(n => onRead(n.id))}>Mark view read</Button>
        </div>
      </div>
      <Field>
        Notification filter
        <Select value={filter} onValueChange={(value) => { setFilter(value); setPage(0); }}>
          <Option value="unread">Unread</Option>
          <Option value="active">Still active</Option>
          <Option value="all">All recent notifications</Option>
        </Select>
      </Field>
      {rows.slice(currentPage * 10, (currentPage + 1) * 10).map((n) => (
        <article className={"notification " + n.severity} key={n.id}>
          <Button
            variant="unstyled"
            className="border-0 px-0 py-3"
            onClick={() => {
              onRead(n.id);
              onInspect(n.kind, n.row);
            }}
          >
            <strong>{n.title}</strong>
            <small>
              {new Date(n.at).toLocaleString()} ·{" "}
              {n.active ? "Active" : "Resolved or no longer present"} ·{" "}
              {n.seen ? "Read" : "Unread"}
            </small>
          </Button>
          {!n.seen && <Button onClick={() => onRead(n.id)}>Mark read</Button>}
        </article>
      ))}
      {!rows.length && <p className="empty">No notifications in this view.</p>}
      {rows.length > 10 && <div className="audit-pagination">
        <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
        <span>Page {currentPage + 1} of {Math.ceil(rows.length / 10)}</span>
        <Button disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>Next</Button>
      </div>}
    </Card>
  );
}
export function useDesktopAlerts(
  items: R[],
  enabled: boolean,
  onInspect: (k: string, r: R) => void,
) {
  const seen = useRef(new Set<string>()),
    initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      items.forEach((n) => seen.current.add(n.id + ":" + n.revision));
      initialized.current = true;
      return;
    }
    for (const n of items) {
      const key = n.id + ":" + n.revision;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (
        enabled &&
        !n.seen &&
        n.active &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        const alert = new Notification("Heimdall · " + n.severity, {
          body: n.title,
          tag: n.id,
        });
        alert.onclick = () => {
          window.focus();
          onInspect(n.kind, n.row);
          alert.close();
        };
      }
    }
  }, [items, enabled]);
}
export function ConnectionEditor({
  source,
  current,
  enabled,
  send,
}: {
  source: string;
  current?: R;
  enabled: boolean;
  send: (b: R) => Promise<any>;
}) {
  const [url, setUrl] = useState(current?.url ?? ""),
    [token, setToken] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => setUrl(current?.url ?? ""), [current?.url]);
  async function act(action: string) {
    setBusy(true);
    try {
      await send({ source, url, token, action });
      setStatus(
        action === "test"
          ? "Authentication check passed."
          : action === "disconnect"
            ? "Disconnected."
            : "Connection saved. Approval pairing must be renewed.",
      );
      setToken("");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Disclosure>
      <DisclosureTrigger>Configure {source} connection</DisclosureTrigger>
      <p className="muted">
        Loopback HTTP only. Source tokens are stored privately on this Mac and
        never returned to the browser. Changing a connection clears its old
        display cache and approval pairing.
      </p>
      <Field>
        Service origin
        <Input
          value={url}
          placeholder={
            source === "mimir"
              ? "http://127.0.0.1:7700"
              : "http://127.0.0.1:4310"
          }
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <Field>
        Source access token
        <Input
          type="password"
          value={token}
          autoComplete="off"
          placeholder="Leave blank to retain the current token"
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <div className="actions">
        {["test", "save", "disconnect"].map((action) => (
          <Button
            key={action}
            disabled={!enabled || busy || (action !== "disconnect" && !url)}
            onClick={() => void act(action)}
          >
            {action === "test"
              ? "Test connection"
              : action === "save"
                ? "Save connection"
                : "Disconnect"}
          </Button>
        ))}
      </div>
      <p role="status">{status}</p>
    </Disclosure>
  );
}
export function Telemetry({
  agent,
  load,
}: {
  agent: R;
  load: () => Promise<R>;
}) {
  const [data, setData] = useState<R | null>(null),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    let gone = false;
    const refresh = () =>
      load()
        .then((d) => {
          if (!gone) {
            setData(d);
            setError("");
          }
        })
        .catch((e) => {
          if (!gone) setError(e.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [agent.id, paused]);
  const text = data?.terminal?.text ?? "";
  const tools: R[] = [];
  let model = data?.info?.model;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      model ??= event.model ?? event.message?.model;
      if (
        event.item?.type?.includes("command") ||
        event.item?.type?.includes("tool")
      )
        tools.push(event.item);
      for (const c of event.message?.content ?? [])
        if (c.type === "tool_use" || c.type === "tool_result") tools.push(c);
    } catch {}
  }
  const observed = data?.info?.observedAt;
  const stale = observed ? Date.now() - Date.parse(observed) > 30000 : null;
  return (
    <Card className="telemetry">
      <div className="section-title">
        <h3>Live session</h3>
        <Button onClick={() => setPaused(!paused)}>
          {paused ? "Resume updates" : "Freeze display"}
        </Button>
      </div>
      {error && (
        <p role="status" className="warning">
          {error}
        </p>
      )}
      <div className="facts">
        <div>
          <small>Model reported by runtime</small>
          {model ?? "Not reported"}
        </div>
        <div>
          <small>Runtime observation</small>
          {observed
            ? new Date(observed).toLocaleTimeString()
            : "Not available"}{" "}
          {stale === true ? "· stale" : stale === false ? "· fresh" : ""}
        </div>
        <div>
          <small>Session state</small>
          {data?.info?.session?.state ?? agent.status}
        </div>
        <div>
          <small>Elapsed session time</small>
          {agent.createdAt
            ? Math.max(
                0,
                Math.floor(
                  ((["completed", "failed", "stopped"].includes(agent.status)
                    ? Date.parse(agent.updatedAt)
                    : Date.now()) -
                    Date.parse(agent.createdAt)) /
                    1000,
                ),
              ) + " seconds"
            : "Not reported"}
        </div>
      </div>
      {data?.errors?.map((e: string) => (
        <p key={e} className="muted">
          {e}
        </p>
      ))}
      <h3>Tool calls and results</h3>
      {tools.slice(-30).map((tool, i) => (
        <Disclosure key={i}>
          <DisclosureTrigger>
            {tool.name ?? tool.type} · {tool.status ?? "recorded"}
          </DisclosureTrigger>
          <CodeBlock>{JSON.stringify(tool, null, 2)}</CodeBlock>
        </Disclosure>
      ))}
      {!tools.length && (
        <p className="muted">
          No structured tool calls in the current terminal window.
        </p>
      )}
      <Disclosure open>
        <DisclosureTrigger>Live output · last 500 lines</DisclosureTrigger>
        <CodeBlock className="terminal" aria-label="Agent terminal output">
          {text ||
            "No terminal output available. Historical session.output events remain in the task timeline."}
        </CodeBlock>
      </Disclosure>
    </Card>
  );
}
export function PipelineSettings({
  stages,
  onSave,
}: {
  stages: string[];
  onSave: (stages: string[]) => void;
}) {
  const [order, setOrder] = useState(stages);
  return (
    <Disclosure>
      <DisclosureTrigger>Configure pipeline stage order</DisclosureTrigger>
      <p className="muted">
        This changes presentation only. Stages still come from authoritative
        source states.
      </p>
      {order.map((s, i) => (
        <div className="stage-setting" key={s}>
          <span>{s}</span>
          <Button
            aria-label={"Move " + s + " earlier"}
            disabled={i === 0}
            onClick={() =>
              setOrder((a) => {
                const b = [...a];
                [b[i - 1], b[i]] = [b[i], b[i - 1]];
                return b;
              })
            }
          >
            ↑
          </Button>
          <Button
            aria-label={"Move " + s + " later"}
            disabled={i === order.length - 1}
            onClick={() =>
              setOrder((a) => {
                const b = [...a];
                [b[i + 1], b[i]] = [b[i], b[i + 1]];
                return b;
              })
            }
          >
            ↓
          </Button>
        </div>
      ))}
      <Button onClick={() => onSave(order)}>Save stage order</Button>
    </Disclosure>
  );
}
