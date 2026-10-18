// A fake HerdR 0.9.4 socket server that reproduces the wire behaviour recorded
// in spikes/herdr-spike/FINDINGS.md and test/fixtures/*.ndjson:
// - one request per connection (respond, then close);
// - subscriptions ack with {type:"subscription_started"} then push envelopes;
//   lifecycle events use underscore `event` names plus `data.type`, status
//   events use the dotted `pane.agent_status_changed` with no `data.type`;
// - `pane.agent_status_changed` requires `pane_id` (invalid_request otherwise,
//   pane_not_found for an unknown pane, failing the whole subscribe call);
// - `agent.start` fails with agent_pane_busy while the shell is starting and
//   returns `launch_pending:true`;
// - `claude -p` style one-shots end with pane_agent_detected{released:true}
//   followed by status `unknown`; the shell lives on and no pane_exited fires;
// - restart = socket removed (ENOENT), subscriptions EOF, panes keep pane_id
//   but get new terminal ids, agents are not restored, pane_updated revision 1.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { HerdrSocketClient } from "../src/socket-client.js";

type Json = Record<string, unknown>;
type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** How an agent started with `agent.start` behaves in the fake. */
export type AgentBehavior =
  | { kind: "oneshot"; output: string; runMs: number; finalStatus?: AgentStatus }
  | { kind: "trust_prompt"; ctrlCToExit?: number }
  | { kind: "interactive"; ctrlCToExit?: number };

interface FgProcess {
  name: string;
  argv: string[];
  timer?: NodeJS.Timeout;
  onInterrupt?: () => void;
}

interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  env: Record<string, string>;
  agent_status: AgentStatus;
  agent: string | null;
  agent_name: string | null;
  agent_session: Json | null;
  launch_pending: boolean;
  state_change_seq: number;
  revision: number;
  shell_pid: number;
  /** Number of further agent.start calls that fail with agent_pane_busy. */
  busyStarts: number;
  fg: FgProcess | null;
  screen: string[];
  ctrlCLeft: number;
  tokens: Record<string, string>;
  /** zsh still running startup hooks; typed input is discarded. */
  starting?: boolean;
}

interface SubEntry {
  type: string;
  pane_id?: string;
  regex?: RegExp;
  currently_matching?: boolean;
}

interface SubConn {
  sock: net.Socket;
  id: string;
  entries: SubEntry[];
}

export interface FakeHerdrOptions {
  /** agent.start calls that fail with agent_pane_busy after workspace.create, even at a bare shell. */
  busyStartsPerPane?: number;
  /** How long a fresh pane runs a non-shell foreground job while zsh starts. */
  shellStartupMs?: number;
  /** During startup, toggle between busy and bare every N ms (0 = steady busy). */
  startupFlickerMs?: number;
  /** Behaviour for agents by argv; default: oneshot when args include -p. */
  agentBehavior?: (kind: string, args: string[]) => AgentBehavior;
  /** Duration multiplier for `sleep N` in shell commands (ms per second). */
  msPerShellSecond?: number;
  /** Interval at which output_matched subscriptions re-sample panes. */
  pollMs?: number;
  version?: string;
  protocol?: number;
}

const LIFECYCLE_TYPES = new Set([
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
]);

const KNOWN_KINDS = new Set(["claude", "codex", "gemini", "opencode", "pi"]);
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

class FakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let termSeq = 0x65dce7000000;
const newTerminalId = () => `term_${(termSeq++).toString(16)}`;

export class FakeHerdr {
  readonly socketPath: string;
  readonly requests: { method: string; params: Json }[] = [];
  readonly panes = new Map<string, FakePane>();
  private server: net.Server | null = null;
  private subs = new Set<SubConn>();
  private nextWs = 1;
  private nextPid = 4000;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<FakeHerdrOptions, "agentBehavior">> & {
    agentBehavior: FakeHerdrOptions["agentBehavior"] | undefined;
  };
  /** When set, the next N requests of a method fail with the given error. */
  readonly failNext = new Map<string, { code: string; message: string; count: number }>();

  constructor(opts: FakeHerdrOptions = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-herdr-"));
    this.socketPath = path.join(dir, "herdr.sock");
    this.opts = {
      busyStartsPerPane: opts.busyStartsPerPane ?? 1,
      shellStartupMs: opts.shellStartupMs ?? 20,
      startupFlickerMs: opts.startupFlickerMs ?? 0,
      msPerShellSecond: opts.msPerShellSecond ?? 20,
      pollMs: opts.pollMs ?? 10,
      version: opts.version ?? "0.9.4",
      protocol: opts.protocol ?? 22,
      agentBehavior: opts.agentBehavior,
    };
  }

  async start(): Promise<void> {
    this.server = net.createServer((sock) => this.onConnection(sock));
    await new Promise<void>((res) => this.server!.listen(this.socketPath, () => res()));
    this.pollTimer = setInterval(() => this.pollOutputMatches(), this.opts.pollMs);
  }

  /** Stops the server like `herdr session stop`: subscriptions get a plain EOF, the socket file disappears. */
  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const s of this.subs) s.sock.end();
    this.subs.clear();
    for (const p of this.panes.values()) if (p.fg?.timer) clearTimeout(p.fg.timer);
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((res) => srv.close(() => res()));
    fs.rmSync(this.socketPath, { force: true });
  }

  /**
   * Restart: panes keep pane_id/workspace/cwd but get new terminal ids; agent
   * processes are not restored; each pane emits pane_updated (revision 1)
   * after `updateDelayMs`, once subscribers have had time to reconnect.
   */
  async restart(
    opts: { downMs?: number; updateDelayMs?: number; startupMs?: number } = {},
  ): Promise<void> {
    await this.stop();
    await delay(opts.downMs ?? 30);
    for (const p of this.panes.values()) {
      p.terminal_id = newTerminalId();
      p.fg = null;
      p.agent = null;
      p.agent_name = null;
      p.agent_session = null;
      p.agent_status = "unknown";
      p.launch_pending = false;
      p.revision = 1;
      p.screen = [];
      p.tokens = {}; // metadata tokens live on the terminal and are not persisted
      p.shell_pid = this.nextPid++;
      if (opts.startupMs) {
        // restored shells run their startup hooks again (live: foreground helpers for seconds)
        const fg: FgProcess = { name: "zsh-startup", argv: ["gitstatusd"] };
        fg.timer = setTimeout(() => {
          if (p.fg === fg) p.fg = null;
        }, opts.startupMs);
        p.fg = fg;
      }
    }
    // Upstream reserve_workspace_ids: the id counter restarts at max(restored)+1,
    // so a closed highest-numbered workspace id is handed out again.
    this.nextWs =
      Math.max(0, ...[...this.panes.values()].map((p) => Number(p.workspace_id.slice(1)))) + 1;
    await this.start();
    setTimeout(() => {
      for (const p of this.panes.values())
        this.lifecycle("pane_updated", { pane: this.paneInfo(p) });
    }, opts.updateDelayMs ?? 60);
  }

  /** A plain client on this server's socket (acts as "someone else"). */
  client(): HerdrSocketClient {
    return new HerdrSocketClient(this.socketPath);
  }

  /** `herdr session delete` + recreate: every pane is gone and ids start again at w1. */
  async recreate(): Promise<void> {
    await this.stop();
    this.panes.clear();
    this.nextWs = 1;
    await this.start();
  }

  /** Called with the parsed entries right before a subscription is acked. */
  beforeSubscribeAck: ((entries: SubEntry[]) => void) | null = null;

  /** Simulates a stalled reader being dropped: every subscription gets EOF with no error line. */
  dropSubscriptions(): void {
    for (const s of this.subs) s.sock.end();
    this.subs.clear();
  }

  /** Sends the documented events_lost error line on every subscription and closes them. */
  eventsLost(): void {
    for (const s of this.subs) {
      s.sock.end(
        JSON.stringify({ id: s.id, error: { code: "events_lost", message: "fell behind" } }) + "\n",
      );
    }
    this.subs.clear();
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  subscriptionEntries(): SubEntry[][] {
    return [...this.subs].map((s) => s.entries.map((e) => ({ ...e })));
  }

  /** Pushes a raw envelope (for example one unwrapped from a fixture) to every subscriber whose entries match. */
  push(envelope: { event: string; data: Json }): void {
    for (const s of this.subs) {
      const match = s.entries.some((e) => entryMatches(e, envelope));
      if (match) s.sock.write(JSON.stringify(envelope) + "\n");
    }
  }

  setStatus(paneId: string, status: AgentStatus): void {
    const p = this.mustPane(paneId);
    p.agent_status = status;
    p.state_change_seq++;
    this.statusEvent(p);
  }

  /** Agent releases the pane (end of `claude -p`): detected{released}, then status unknown. */
  release(paneId: string, finalStatus: AgentStatus = "idle"): void {
    const p = this.mustPane(paneId);
    const agent = p.agent;
    p.fg = null;
    this.lifecycle("pane_agent_detected", {
      agent,
      final_status: finalStatus,
      pane_id: p.pane_id,
      released: true,
      workspace_id: p.workspace_id,
    });
    p.agent = null;
    p.agent_name = null;
    p.agent_status = "unknown";
    p.state_change_seq++;
    this.statusEvent(p);
  }

  // ---------------------------------------------------------------- server

  private onConnection(sock: net.Socket): void {
    let buf = "";
    let handled = false;
    sock.on("error", () => {});
    sock.on("data", (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      handled = true;
      let msg: { id: string; method: string; params?: Json };
      try {
        msg = JSON.parse(buf.slice(0, i));
      } catch {
        sock.end();
        return;
      }
      void this.handle(sock, msg);
    });
  }

  private async handle(
    sock: net.Socket,
    msg: { id: string; method: string; params?: Json },
  ): Promise<void> {
    const params = msg.params ?? {};
    this.requests.push({ method: msg.method, params });
    const reply = (body: Json) => {
      if (msg.method === "events.subscribe" && "result" in body)
        sock.write(JSON.stringify({ id: msg.id, ...body }) + "\n");
      else sock.end(JSON.stringify({ id: msg.id, ...body }) + "\n");
    };
    try {
      const forced = this.failNext.get(msg.method);
      if (forced && forced.count > 0) {
        forced.count--;
        throw new FakeError(forced.code, forced.message);
      }
      if (msg.method === "events.subscribe") {
        const entries = this.parseSubscriptions(params);
        const conn: SubConn = { sock, id: msg.id, entries };
        this.beforeSubscribeAck?.(entries);
        reply({ result: { type: "subscription_started" } });
        this.subs.add(conn);
        sock.on("close", () => this.subs.delete(conn));
        // Status subscriptions report an initial sample only when filtered; output matches sample now.
        this.pollOutputMatches();
        return;
      }
      const result = await this.dispatch(msg.method, params);
      reply({ result });
    } catch (e) {
      const err = e instanceof FakeError ? e : new FakeError("internal_error", String(e));
      reply({ error: { code: err.code, message: err.message } });
    }
  }

  private parseSubscriptions(params: Json): SubEntry[] {
    const subs = params.subscriptions;
    if (!Array.isArray(subs))
      throw new FakeError("invalid_request", "invalid request: missing field `subscriptions`");
    return subs.map((raw: Json) => {
      const type = String(raw.type);
      if (LIFECYCLE_TYPES.has(type)) return { type };
      if (type === "pane.agent_status_changed" || type === "pane.scroll_changed") {
        if (typeof raw.pane_id !== "string")
          throw new FakeError("invalid_request", "invalid request: missing field `pane_id`");
        if (!this.panes.has(raw.pane_id)) throw new FakeError("pane_not_found", "pane not found");
        return { type, pane_id: raw.pane_id };
      }
      if (type === "pane.output_matched") {
        if (typeof raw.pane_id !== "string")
          throw new FakeError("invalid_request", "invalid request: missing field `pane_id`");
        if (!this.panes.has(raw.pane_id)) throw new FakeError("pane_not_found", "pane not found");
        const m = raw.match as { type?: string; value?: string } | undefined;
        if (!raw.source || !m?.value)
          throw new FakeError("invalid_request", "invalid request: missing field `match`");
        const regex = m.type === "regex" ? new RegExp(m.value) : new RegExp(escapeRegex(m.value));
        return { type, pane_id: raw.pane_id, regex, currently_matching: false };
      }
      throw new FakeError("invalid_request", `invalid request: unknown variant \`${type}\``);
    });
  }

  private async dispatch(method: string, params: Json): Promise<Json> {
    switch (method) {
      case "ping":
        return {
          type: "pong",
          version: this.opts.version,
          protocol: this.opts.protocol,
          capabilities: {
            live_handoff: true,
            detached_server_daemon: true,
            endpoint_protocol_generation: 1,
          },
        };
      case "session.snapshot":
        return { type: "session_snapshot", snapshot: this.snapshot() };
      case "workspace.create":
        return this.workspaceCreate(params);
      case "pane.process_info": {
        const p = this.mustPane(String(params.pane_id));
        return { type: "pane_process_info", process_info: this.processInfo(p) };
      }
      case "pane.read": {
        const p = this.mustPane(String(params.pane_id));
        return { type: "pane_read", read: this.read(p, params) };
      }
      case "pane.send_text": {
        const p = this.mustPane(String(params.pane_id));
        this.typeText(p, String(params.text));
        return { type: "ok" };
      }
      case "pane.send_keys": {
        const p = this.mustPane(String(params.pane_id));
        this.sendKeys(p, params.keys as string[]);
        return { type: "ok" };
      }
      case "pane.report_metadata": {
        const p = this.mustPane(String(params.pane_id));
        if (typeof params.source !== "string" || !params.source)
          throw new FakeError("invalid_metadata_source", "metadata source must not be empty");
        const tokens = (params.tokens ?? {}) as Record<string, string | null>;
        for (const [k, v] of Object.entries(tokens)) {
          if (v === null) delete p.tokens[k];
          else p.tokens[k] = v;
        }
        p.revision++;
        return { type: "ok" };
      }
      case "pane.close":
        this.closePane(this.mustPane(String(params.pane_id)));
        return { type: "ok" };
      case "agent.start":
        return this.agentStart(params);
      case "agent.get":
        return { type: "agent_info", agent: this.agentInfo(this.mustAgent(String(params.target))) };
      case "agent.wait":
        return this.agentWait(params);
      case "agent.prompt": {
        const p = this.mustAgent(String(params.target));
        if (p.launch_pending || p.agent_status !== "idle") {
          throw new FakeError("agent_not_ready", `agent ${p.pane_id} is not an active named agent`);
        }
        p.screen.push(`> ${String(params.text)}`);
        return { type: "agent_prompted", agent: this.agentInfo(p) };
      }
      case "agent.send_keys": {
        const p = this.mustAgent(String(params.target));
        this.sendKeys(p, params.keys as string[]);
        return { type: "ok" };
      }
      default:
        throw new FakeError("unknown_method", `unknown method ${method}`);
    }
  }

  // ------------------------------------------------------------- behaviour

  private workspaceCreate(params: Json): Json {
    const n = this.nextWs++;
    const workspace_id = `w${n}`;
    const tab_id = `${workspace_id}:t1`;
    const pane: FakePane = {
      pane_id: `${workspace_id}:p1`,
      terminal_id: newTerminalId(),
      workspace_id,
      tab_id,
      cwd: typeof params.cwd === "string" ? params.cwd : os.homedir(),
      env: (params.env as Record<string, string>) ?? {},
      agent_status: "unknown",
      agent: null,
      agent_name: null,
      agent_session: null,
      launch_pending: false,
      state_change_seq: 0,
      revision: 0,
      shell_pid: this.nextPid++,
      busyStarts: this.opts.busyStartsPerPane,
      // zsh is still starting: a non-shell foreground job (e.g. a prompt helper).
      fg: this.opts.shellStartupMs > 0 ? { name: "zsh-startup", argv: ["gitstatusd"] } : null,
      screen: [],
      ctrlCLeft: 0,
      tokens: {},
    };
    this.panes.set(pane.pane_id, pane);
    if (pane.fg) {
      // Live 0.9.4 + zsh with plugins: startup alternates between short bare-shell
      // windows and helper processes, and input typed before it settles is lost.
      const startup = pane.fg;
      pane.starting = true;
      const flicker = this.opts.startupFlickerMs;
      const toggle =
        flicker > 0
          ? setInterval(() => {
              if (!pane.starting) return;
              pane.fg = pane.fg ? null : startup;
            }, flicker)
          : null;
      startup.timer = setTimeout(() => {
        if (toggle) clearInterval(toggle);
        pane.starting = false;
        if (pane.fg === startup || pane.fg === null) pane.fg = null;
      }, this.opts.shellStartupMs);
    }
    const workspace = {
      workspace_id,
      number: n,
      label: params.label ?? null,
      focused: false,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: tab_id,
      agent_status: "unknown",
    };
    const tab = {
      tab_id,
      workspace_id,
      number: 1,
      label: "1",
      focused: false,
      pane_count: 1,
      agent_status: "unknown",
    };
    // Responses arrive before their events.
    setTimeout(() => {
      this.lifecycle("workspace_created", { workspace });
      this.lifecycle("tab_created", { tab });
      this.lifecycle("pane_created", { pane: this.paneInfo(pane) });
      this.lifecycle("layout_updated", {
        layout: { workspace_id, tab_id, focused_pane_id: pane.pane_id },
      });
    }, 5);
    return { type: "workspace_created", workspace, tab, root_pane: this.paneInfo(pane) };
  }

  private agentStart(params: Json): Json {
    const name = String(params.name ?? "");
    const kind = String(params.kind ?? "");
    const args = (params.args as string[] | undefined) ?? [];
    if (!AGENT_NAME.test(name))
      throw new FakeError("invalid_agent_name", "agent name must start with a lowercase letter");
    if (!KNOWN_KINDS.has(kind))
      throw new FakeError("unsupported_agent_kind", `unsupported interactive agent kind ${kind}`);
    const p = this.panes.get(String(params.pane_id));
    if (!p)
      throw new FakeError(
        "agent_pane_not_found",
        `agent target pane ${String(params.pane_id)} not found`,
      );
    if (p.busyStarts > 0 || p.fg) {
      if (p.busyStarts > 0) p.busyStarts--;
      throw new FakeError(
        "agent_pane_busy",
        `agent target pane ${p.pane_id} is not an available shell`,
      );
    }
    p.agent_name = name;
    p.launch_pending = true;
    p.agent_status = "unknown";
    p.revision++;
    p.screen.push(`$ ${kind} ${args.join(" ")}`);
    const behavior =
      this.opts.agentBehavior?.(kind, args) ??
      (args.includes("-p")
        ? { kind: "oneshot" as const, output: "PONG", runMs: 60 }
        : { kind: "interactive" as const });
    p.fg = { name: `${kind}.exe`, argv: [kind, ...args] };
    setTimeout(() => this.runAgent(p, kind, behavior), 10);
    return {
      type: "agent_started",
      agent: {
        ...this.agentInfo(p),
        launch_pending: true,
        agent_status: "unknown",
        state_change_seq: 0,
      },
      argv: [kind, ...args],
    };
  }

  private runAgent(p: FakePane, kind: string, behavior: AgentBehavior): void {
    if (!this.panes.has(p.pane_id) || !p.fg) return;
    p.agent = kind;
    this.lifecycle("pane_agent_detected", {
      agent: kind,
      pane_id: p.pane_id,
      workspace_id: p.workspace_id,
    });
    if (behavior.kind === "oneshot") {
      p.launch_pending = false;
      this.setStatus(p.pane_id, "idle");
      p.fg.timer = setTimeout(() => {
        if (!this.panes.has(p.pane_id)) return;
        p.screen.push(behavior.output);
        p.agent_session = {
          agent: kind,
          kind: "id",
          source: `herdr:${kind}`,
          value: "6e333a66-0320-4e7f-b464-d788bbf200d8",
        };
        p.revision++;
        this.lifecycle("pane_updated", { pane: this.paneInfo(p) });
        this.release(p.pane_id, behavior.finalStatus ?? "idle");
      }, behavior.runMs);
    } else if (behavior.kind === "trust_prompt") {
      p.ctrlCLeft = behavior.ctrlCToExit ?? 2;
      p.screen.push(
        " Accessing workspace:",
        "",
        " Quick safety check: Is this a project you created or one you trust?",
        " ❯ 1. Yes, I trust this folder",
        "   2. No, exit",
      );
      this.setStatus(p.pane_id, "blocked");
    } else {
      p.ctrlCLeft = behavior.ctrlCToExit ?? 2;
      p.launch_pending = false;
      this.setStatus(p.pane_id, "idle");
    }
  }

  private async agentWait(params: Json): Promise<Json> {
    const target = String(params.target);
    const until = (params.until as AgentStatus[] | undefined) ?? ["idle", "done", "blocked"];
    const deadline = Date.now() + Number(params.timeout_ms ?? 30_000);
    for (;;) {
      const p = this.mustAgent(target);
      if (until.includes(p.agent_status) && p.agent)
        return { type: "agent_info", agent: this.agentInfo(p) };
      if (Date.now() > deadline)
        throw new FakeError("timeout", `timed out waiting for agent ${target}`);
      await delay(5);
    }
  }

  private typeText(p: FakePane, text: string): void {
    if (p.starting) return; // eaten by the starting shell
    const last = p.screen.length ? p.screen[p.screen.length - 1]! : "";
    if (last.startsWith("$ ") && last.endsWith("\u0000"))
      p.screen[p.screen.length - 1] = last.slice(0, -1) + text + "\u0000";
    else p.screen.push(`$ ${text}\u0000`); // \0 marks the pending (unsubmitted) command line
  }

  private sendKeys(p: FakePane, keys: string[]): void {
    for (const key of keys) {
      if (key === "enter") this.submitLine(p);
      else if (key === "ctrl+c") this.interrupt(p);
    }
  }

  private submitLine(p: FakePane): void {
    const i = p.screen.findIndex((l) => l.endsWith("\u0000"));
    if (i < 0) return;
    const line = p.screen[i]!.slice(2, -1);
    p.screen[i] = `$ ${line}`;
    this.runShell(p, line);
  }

  private readonly vars = new Map<string, Map<string, string>>();

  /** Unexported shell variables per pane (`NAME=$?`), as zsh keeps them across command lines. */
  private shellVars(p: FakePane): Map<string, string> {
    let v = this.vars.get(p.pane_id);
    if (!v) this.vars.set(p.pane_id, (v = new Map()));
    return v;
  }

  /**
   * A tiny zsh: `cmd; NAME=$?` then later `echo MIMIR_DONE:<id>:<nonce>:$NAME`, where cmd is
   * sleep N, true, false, exit-with, echo.
   */
  private runShell(p: FakePane, line: string): void {
    const parts = line.split(/\s*;\s*/);
    const run = (idx: number, status: number) => {
      if (idx >= parts.length || !this.panes.has(p.pane_id)) return;
      const cmd = parts[idx]!.trim();
      const words = cmd.split(/\s+/);
      if (words[0] === "sleep") {
        const ms = Number(words[1] ?? 0) * this.opts.msPerShellSecond;
        const fg: FgProcess = { name: "sleep", argv: words };
        fg.onInterrupt = () => {
          if (fg.timer) clearTimeout(fg.timer);
          p.fg = null;
          p.screen.push("^C"); // zsh abandons the rest of the list on SIGINT
        };
        fg.timer = setTimeout(() => {
          p.fg = null;
          run(idx + 1, 0);
        }, ms);
        p.fg = fg;
        return;
      }
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=\$\?$/.exec(cmd);
      if (assign) {
        this.shellVars(p).set(assign[1]!, String(status));
        return run(idx + 1, status);
      }
      if (words[0] === "echo") {
        const vars = this.shellVars(p);
        const text = words
          .slice(1)
          .join(" ")
          .replace("$?", String(status))
          .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => vars.get(name) ?? "");
        p.screen.push(text);
        return run(idx + 1, 0);
      }
      if (words[0] === "false") return run(idx + 1, 1);
      if (words[0] === "exit-with") return run(idx + 1, Number(words[1] ?? 0));
      return run(idx + 1, 0);
    };
    run(0, 0);
  }

  private interrupt(p: FakePane): void {
    if (!p.fg) return;
    if (p.fg.onInterrupt) return p.fg.onInterrupt();
    if (p.agent || p.agent_name) {
      p.ctrlCLeft--;
      if (p.ctrlCLeft > 0) {
        p.screen.push("Press Ctrl-C again to exit");
        // HerdR reports idle right away even though the process is still alive (FINDINGS (a)).
        if (p.agent_status !== "idle") this.setStatus(p.pane_id, "idle");
        return;
      }
      if (p.fg.timer) clearTimeout(p.fg.timer);
      this.release(p.pane_id, "idle");
    }
  }

  private closePane(p: FakePane): void {
    if (p.fg?.timer) clearTimeout(p.fg.timer);
    this.panes.delete(p.pane_id);
    // Closing the last pane closes the workspace; workspace_closed arrives before pane_closed.
    setTimeout(() => {
      this.lifecycle("workspace_closed", {
        workspace: { workspace_id: p.workspace_id },
        workspace_id: p.workspace_id,
      });
      this.lifecycle("pane_closed", { pane_id: p.pane_id, workspace_id: p.workspace_id });
    }, 5);
  }

  /** Adds an existing pane (e.g. the recorded `root_pane` of a fixture) at a bare shell. */
  seedPane(pane: {
    pane_id: string;
    workspace_id: string;
    terminal_id: string;
    cwd: string;
  }): void {
    this.panes.set(pane.pane_id, {
      ...pane,
      tab_id: `${pane.workspace_id}:t1`,
      env: {},
      agent_status: "unknown",
      agent: null,
      agent_name: null,
      agent_session: null,
      launch_pending: false,
      state_change_seq: 0,
      revision: 0,
      shell_pid: this.nextPid++,
      busyStarts: 0,
      fg: null,
      screen: [],
      ctrlCLeft: 0,
      tokens: {},
    });
  }

  /** Shell exits (e.g. `exit` typed): pane_exited. */
  exitShell(paneId: string): void {
    const p = this.mustPane(paneId);
    this.lifecycle("pane_exited", { pane_id: p.pane_id, workspace_id: p.workspace_id });
  }

  // ------------------------------------------------------------- shapes

  private mustPane(paneId: string): FakePane {
    const p = this.panes.get(paneId);
    if (!p) throw new FakeError("pane_not_found", "pane not found");
    return p;
  }

  private mustAgent(target: string): FakePane {
    const p = this.panes.get(target);
    if (!p || !p.agent_name)
      throw new FakeError("agent_not_found", `agent target ${target} not found`);
    return p;
  }

  paneInfo(p: FakePane): Json {
    return {
      pane_id: p.pane_id,
      terminal_id: p.terminal_id,
      workspace_id: p.workspace_id,
      tab_id: p.tab_id,
      focused: false,
      cwd: p.cwd,
      foreground_cwd: p.cwd,
      agent: p.agent,
      agent_session: p.agent_session,
      agent_status: p.agent_status,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 40 },
      revision: p.revision,
      tokens: { ...p.tokens },
    };
  }

  private agentInfo(p: FakePane): Json {
    return {
      ...this.paneInfo(p),
      name: p.agent_name,
      launch_pending: p.launch_pending,
      state_change_seq: p.state_change_seq,
      completion_seq: 0,
    };
  }

  private processInfo(p: FakePane): Json {
    const shell = {
      pid: p.shell_pid,
      name: "zsh",
      argv0: "zsh",
      argv: ["-zsh"],
      cmdline: "-zsh",
      cwd: p.cwd,
    };
    if (!p.fg) {
      return {
        pane_id: p.pane_id,
        shell_pid: p.shell_pid,
        foreground_process_group_id: p.shell_pid,
        foreground_processes: [shell],
      };
    }
    const pid = p.shell_pid + 1000;
    return {
      pane_id: p.pane_id,
      shell_pid: p.shell_pid,
      foreground_process_group_id: pid,
      foreground_processes: [
        {
          pid,
          name: p.fg.name,
          argv0: p.fg.argv[0],
          argv: p.fg.argv,
          cmdline: p.fg.argv.join(" "),
          cwd: p.cwd,
        },
      ],
    };
  }

  private read(p: FakePane, params: Json): Json {
    const lines = typeof params.lines === "number" ? params.lines : 40;
    const text = p.screen
      .map((l) => (l.endsWith("\u0000") ? l.slice(0, -1) : l))
      .slice(-lines)
      .join("\n");
    return {
      pane_id: p.pane_id,
      workspace_id: p.workspace_id,
      tab_id: p.tab_id,
      source: params.source ?? "recent",
      format: "text",
      text: text + "\n",
      revision: 0,
      truncated: false,
    };
  }

  private snapshot(): Json {
    const panes = [...this.panes.values()];
    const workspaces = [...new Set(panes.map((p) => p.workspace_id))].map((w, i) => ({
      workspace_id: w,
      number: i + 1,
      focused: false,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: `${w}:t1`,
      agent_status: "unknown",
    }));
    return {
      version: this.opts.version,
      protocol: this.opts.protocol,
      focused_workspace_id: null,
      focused_tab_id: null,
      focused_pane_id: null,
      workspaces,
      tabs: panes.map((p) => ({
        tab_id: p.tab_id,
        workspace_id: p.workspace_id,
        number: 1,
        focused: false,
        pane_count: 1,
      })),
      panes: panes.map((p) => this.paneInfo(p)),
      layouts: [],
      agents: panes.filter((p) => p.agent_name).map((p) => this.agentInfo(p)),
    };
  }

  // ------------------------------------------------------------- events

  private lifecycle(type: string, data: Json): void {
    this.push({ event: type, data: { type, ...data } });
  }

  private statusEvent(p: FakePane): void {
    const data: Json = {
      agent_status: p.agent_status,
      pane_id: p.pane_id,
      workspace_id: p.workspace_id,
    };
    if (p.agent) data.agent = p.agent;
    this.push({ event: "pane.agent_status_changed", data });
  }

  private pollOutputMatches(): void {
    for (const s of this.subs) {
      for (const e of s.entries) {
        if (e.type !== "pane.output_matched" || !e.pane_id || !e.regex) continue;
        const p = this.panes.get(e.pane_id);
        if (!p) continue;
        const read = this.read(p, { source: "recent", lines: 200 });
        const line = String(read.text)
          .split("\n")
          .find((l) => e.regex!.test(l));
        if (line === undefined) {
          e.currently_matching = false;
          continue;
        }
        if (e.currently_matching) continue;
        e.currently_matching = true;
        s.sock.write(
          JSON.stringify({
            event: "pane.output_matched",
            data: { pane_id: p.pane_id, matched_line: line, read },
          }) + "\n",
        );
      }
    }
  }
}

function entryMatches(e: SubEntry, env: { event: string; data: Json }): boolean {
  if (env.event === "pane.agent_status_changed")
    return e.type === env.event && e.pane_id === env.data.pane_id;
  if (env.event.startsWith("pane.")) return e.type === env.event && e.pane_id === env.data.pane_id;
  // lifecycle: subscribed as dotted type, pushed with underscore name
  const dotted = env.event.replace("_", ".");
  return e.type === dotted;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
