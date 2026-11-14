// A readable view of an agent's session output. Agent CLIs stream events as JSON lines (Codex
// `exec --json`, Claude `--output-format stream-json`); this turns them into what a person reads:
// what the agent said, the commands it ran with their result, the tools it called and the files it
// changed. Lines that are not agent events (a plain terminal) are kept as text, and the raw lines
// are one switch away.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib.js";
import { Badge } from "./status.js";
import { SegmentedControl } from "./controls.js";

export type TranscriptEntry =
  | { kind: "text"; key: string; text: string }
  | { kind: "message"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | {
      kind: "command";
      key: string;
      command: string;
      output?: string | undefined;
      exitCode?: number | null | undefined;
      running: boolean;
      failed: boolean;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      summary?: string | undefined;
      output?: string | undefined;
      running: boolean;
      failed: boolean;
    }
  | { kind: "files"; key: string; paths: string[] }
  | { kind: "todo"; key: string; items: { text: string; done: boolean }[] }
  | { kind: "done"; key: string; ok: boolean; detail?: string | undefined };

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** `/bin/zsh -lc "rg -n 'x' src"` → `rg -n 'x' src`: the shell wrapper Codex adds says nothing. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/.exec(command.trim());
  return m ? m[2]!.replace(/\\(["\\])/g, "$1") : command;
}

const tokens = (usage: unknown): string | undefined => {
  const u = obj(usage);
  const i = u["input_tokens"],
    o = u["output_tokens"];
  if (typeof i !== "number" || typeof o !== "number") return undefined;
  const n = (x: number) => x.toLocaleString("en-US");
  return `${n(i)} tokens in · ${n(o)} out`;
};

/** Tool result content: a string, or a list of `{type: "text", text}` parts. */
const contentText = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (Array.isArray(v))
    return v
      .map((p) => str(obj(p)["text"]) ?? "")
      .filter(Boolean)
      .join("\n");
  return undefined;
};

/** The one argument that says what a tool call was about. */
const toolSummary = (input: unknown): string | undefined => {
  const i = obj(input);
  for (const k of ["file_path", "path", "pattern", "url", "query", "command", "description"])
    if (typeof i[k] === "string") return i[k] as string;
  const json = JSON.stringify(input);
  return json && json !== "{}" ? (json.length > 160 ? json.slice(0, 157) + "…" : json) : undefined;
};

/** Read JSON events from lines, re-joining an event a terminal split over several lines. */
function events(lines: readonly string[]): { at: number; value: J | null; text: string }[] {
  const out: { at: number; value: J | null; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith("{")) {
      out.push({ at: i, value: null, text: line });
      continue;
    }
    let joined = line,
      parsed: J | null = null,
      end = i;
    for (let k = i; k < Math.min(lines.length, i + 50); k++) {
      if (k > i) joined += lines[k];
      try {
        parsed = obj(JSON.parse(joined));
        end = k;
        break;
      } catch {
        // keep joining
      }
    }
    if (parsed && typeof parsed["type"] === "string") {
      out.push({ at: i, value: parsed, text: joined });
      i = end;
    } else out.push({ at: i, value: null, text: line });
  }
  return out;
}

/** Turn an agent's output lines into transcript entries (Codex, Claude, or plain text). */
export function parseAgentStream(lines: readonly string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const byKey = new Map<string, number>();
  const put = (e: TranscriptEntry) => {
    const at = byKey.get(e.key);
    if (at === undefined) {
      byKey.set(e.key, entries.length);
      entries.push(e);
    } else entries[at] = e;
  };
  for (const { at, value: ev, text } of events(lines)) {
    const key = "l" + at;
    if (!ev) {
      put({ kind: "text", key, text });
      continue;
    }
    const type = ev["type"];
    // Codex exec --json
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = obj(ev["item"]);
      const id = "i:" + String(item["id"] ?? at);
      const done = type === "item.completed";
      switch (item["type"]) {
        case "agent_message":
          put({ kind: "message", key: id, text: str(item["text"]) ?? "" });
          break;
        case "reasoning":
          put({ kind: "thinking", key: id, text: str(item["text"]) ?? "" });
          break;
        case "command_execution": {
          const exit = item["exit_code"];
          const status = item["status"];
          put({
            kind: "command",
            key: id,
            command: unwrapShell(str(item["command"]) ?? ""),
            output: str(item["aggregated_output"]),
            exitCode: typeof exit === "number" ? exit : null,
            running: !done && status !== "completed" && status !== "failed",
            failed: status === "failed" || (typeof exit === "number" && exit !== 0),
          });
          break;
        }
        case "mcp_tool_call": {
          const result = obj(item["result"]);
          put({
            kind: "tool",
            key: id,
            name: `${str(item["server"]) ?? "tool"} · ${str(item["tool"]) ?? ""}`,
            summary: toolSummary(item["arguments"]),
            output: contentText(result["content"]) ?? str(obj(item["error"])["message"]),
            running: !done && item["status"] !== "completed" && item["status"] !== "failed",
            failed: item["status"] === "failed",
          });
          break;
        }
        case "web_search":
          put({
            kind: "tool",
            key: id,
            name: "Web search",
            summary: str(item["query"]),
            running: !done,
            failed: false,
          });
          break;
        case "file_change":
          put({
            kind: "files",
            key: id,
            paths: (Array.isArray(item["changes"]) ? item["changes"] : [])
              .map((c) => str(obj(c)["path"]))
              .filter((p): p is string => !!p),
          });
          break;
        case "todo_list":
          put({
            kind: "todo",
            key: id,
            items: (Array.isArray(item["items"]) ? item["items"] : []).map((t) => ({
              text: str(obj(t)["text"]) ?? "",
              done: obj(t)["completed"] === true,
            })),
          });
          break;
        case "error":
          put({ kind: "text", key: id, text: "Error: " + (str(item["message"]) ?? "") });
          break;
      }
      continue;
    }
    if (type === "turn.completed") {
      put({ kind: "done", key, ok: true, detail: tokens(ev["usage"]) });
      continue;
    }
    if (type === "turn.failed") {
      put({ kind: "done", key, ok: false, detail: str(obj(ev["error"])["message"]) });
      continue;
    }
    if (type === "error") {
      put({ kind: "text", key, text: "Error: " + (str(ev["message"]) ?? "") });
      continue;
    }
    // Claude stream-json
    if (type === "assistant" || type === "user") {
      const content = obj(ev["message"])["content"];
      for (const part of Array.isArray(content) ? content : []) {
        const p = obj(part);
        if (p["type"] === "text" && str(p["text"])?.trim())
          put({ kind: "message", key: key + ":" + entries.length, text: str(p["text"])! });
        else if (p["type"] === "thinking" && str(p["thinking"])?.trim())
          put({ kind: "thinking", key: key + ":" + entries.length, text: str(p["thinking"])! });
        else if (p["type"] === "tool_use") {
          const id = "t:" + String(p["id"]);
          const input = obj(p["input"]);
          if (p["name"] === "Bash" && typeof input["command"] === "string")
            put({
              kind: "command",
              key: id,
              command: input["command"],
              running: true,
              failed: false,
            });
          else
            put({
              kind: "tool",
              key: id,
              name: str(p["name"]) ?? "tool",
              summary: toolSummary(p["input"]),
              running: true,
              failed: false,
            });
        } else if (p["type"] === "tool_result") {
          const id = "t:" + String(p["tool_use_id"]);
          const at = byKey.get(id);
          const prior = at === undefined ? undefined : entries[at];
          if (prior && (prior.kind === "tool" || prior.kind === "command"))
            put({
              ...prior,
              output: contentText(p["content"]),
              running: false,
              failed: p["is_error"] === true,
            });
        }
      }
      continue;
    }
    if (type === "result") {
      const ok = ev["subtype"] === "success" && ev["is_error"] !== true;
      put({
        kind: "done",
        key,
        ok,
        detail: ok ? tokens(ev["usage"]) : (str(ev["result"]) ?? str(ev["subtype"])),
      });
    }
    // Other events (thread.started, turn.started, system init, …) carry nothing to read.
  }
  return entries;
}

const lineCount = (s: string) => s.replace(/\n$/, "").split("\n").length;

function Output({ text, label = "Output" }: { text: string; label?: string }) {
  if (!text.trim()) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted select-none hover:text-fg">
        {label} ({lineCount(text)} {lineCount(text) === 1 ? "line" : "lines"})
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs whitespace-pre-wrap text-muted">
        {text}
      </pre>
    </details>
  );
}

function state(running: boolean, failed: boolean, exitCode?: number | null) {
  if (running) return <Badge tone="info">Running</Badge>;
  if (failed)
    return <Badge tone="danger">{exitCode != null ? `Exit ${exitCode}` : "Failed"}</Badge>;
  return <Badge tone="forest">{exitCode != null ? `Exit ${exitCode}` : "Done"}</Badge>;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3 px-4 py-2.5">
      <span className="w-20 shrink-0 pt-0.5 text-xs font-medium text-subtle">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function Entry({ e }: { e: TranscriptEntry }) {
  switch (e.kind) {
    case "message":
      return (
        <Row label="Agent">
          <p className="text-sm whitespace-pre-wrap text-fg">{e.text}</p>
        </Row>
      );
    case "thinking":
      return (
        <Row label="Thinking">
          <p className="text-xs whitespace-pre-wrap text-muted italic">
            {e.text.replace(/\*\*/g, "")}
          </p>
        </Row>
      );
    case "command":
      return (
        <Row label="Ran">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <code className="min-w-0 font-mono text-xs break-all whitespace-pre-wrap text-fg">
              {e.command}
            </code>
            <span className="shrink-0">{state(e.running, e.failed, e.exitCode)}</span>
          </div>
          {e.output && <Output text={e.output} />}
        </Row>
      );
    case "tool":
      return (
        <Row label="Tool">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <span className="min-w-0 text-xs">
              <span className="font-medium text-fg">{e.name}</span>
              {e.summary && (
                <span className="ml-2 font-mono break-all text-muted">{e.summary}</span>
              )}
            </span>
            <span className="shrink-0">{state(e.running, e.failed)}</span>
          </div>
          {e.output && <Output text={e.output} label="Result" />}
        </Row>
      );
    case "files":
      return (
        <Row label="Changed">
          <ul className="font-mono text-xs text-fg">
            {e.paths.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        </Row>
      );
    case "todo":
      return (
        <Row label="Plan">
          <ul className="text-xs">
            {e.items.map((t, i) => (
              <li key={i} className={cn(t.done ? "text-muted line-through" : "text-fg")}>
                {t.done ? "☑" : "☐"} {t.text}
              </li>
            ))}
          </ul>
        </Row>
      );
    case "done":
      return (
        <Row label={e.ok ? "Finished" : "Failed"}>
          <span className={cn("text-xs", e.ok ? "text-muted" : "text-danger-fg")}>
            {e.detail ??
              (e.ok ? "The agent finished its turn." : "The agent stopped with an error.")}
          </span>
        </Row>
      );
    case "text":
      return (
        <Row label="Output">
          <pre className="font-mono text-xs break-all whitespace-pre-wrap text-muted">{e.text}</pre>
        </Row>
      );
  }
}

/** An agent's session output as a readable transcript, with the raw lines one switch away. */
export function AgentTranscript({
  lines,
  empty = "No output yet.",
  maxHeight = "560px",
  follow = true,
  className,
}: {
  lines: readonly string[];
  empty?: ReactNode | undefined;
  maxHeight?: string | undefined;
  /** Keep the newest output in view, unless the reader scrolled up. */
  follow?: boolean | undefined;
  className?: string | undefined;
}) {
  const [view, setView] = useState("readable");
  const entries = parseAgentStream(lines);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (follow && el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [follow, lines.length, view]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <SegmentedControl
        label="Output view"
        size="sm"
        value={view}
        onValueChange={setView}
        options={[
          { value: "readable", label: "Readable" },
          { value: "raw", label: "Raw" },
        ]}
        className="self-start"
      />
      <div
        ref={box}
        tabIndex={0}
        role="region"
        aria-label="Agent output"
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="overflow-auto rounded-lg border border-line bg-surface"
        style={{ maxHeight }}
      >
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">{empty}</p>
        ) : view === "raw" ? (
          <pre className="p-3 font-mono text-xs break-all whitespace-pre-wrap text-muted">
            {lines.join("\n")}
          </pre>
        ) : (
          <ol className="divide-y divide-line">
            {entries.map((e) => (
              <Entry key={e.key} e={e} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
