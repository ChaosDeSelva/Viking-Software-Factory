// HerdrAdapter: the only place Mimir talks to HerdR. Built on the wire facts
// in docs/herdr/wire-facts.md (numbers in comments refer to those facts).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
  type RuntimeSessionState,
} from "@mimir/protocol";
import {
  JsonFileBindingStore,
  defaultBindingsPath,
  type BindingStore,
  type SessionBinding,
} from "./bindings.js";
import {
  HerdrError,
  HerdrSocketClient,
  resolveSocketPath,
  toMimirError,
  type CloseInfo,
  type HerdrEnvelope,
  type HerdrSubscription,
} from "./socket-client.js";
import {
  TERMINAL_STATES,
  isTrustPrompt,
  mapAgentStatus,
  parseSentinel,
  releaseState,
  sentinelRegex,
} from "./state-map.js";

export const SHELL_AGENT_KIND = "shell";
export const SESSION_ENV_MARKER = "MIMIR_SESSION_ID";
export const TRUST_PROMPT_STATUS = "blocked:trust_prompt";
export const HERDR_PROTOCOL = 22;
/** Pane metadata token (`pane.report_metadata`) carrying the session marker; HerdR exposes it on PaneInfo.tokens. */
export const SESSION_TOKEN_KEY = "mimir_session";
export const METADATA_SOURCE = "mimir";
/** Shell variable holding a shell-kind command's exit status until the sentinel line prints it. */
export const SHELL_RC_VAR = "__mimir_rc";

/** Agent kinds `agent.start` accepts in 0.9.4 (upstream src/detect/mod.rs), plus Mimir's `shell`. */
export const HERDR_AGENT_KINDS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "opencode",
  "copilot",
  "pi",
  "devin",
  "cline",
  "amp",
  "droid",
  "kimi",
  "kiro",
  "qwen",
] as const;

/** Lifecycle subscription types (dotted); pushed with underscore names (fact 2). */
export const LIFECYCLE_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.closed",
  "pane.created",
  "pane.closed",
  "pane.updated",
  "pane.exited",
  "pane.agent_detected",
] as const;

export interface HerdrTiming {
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  /** Bare-shell wait after workspace.create: poll `pane.process_info` up to attempts × interval… */
  shellReadyAttempts: number;
  shellReadyIntervalMs: number;
  /** …until the shell has been the only foreground process for this long (zsh startup flickers). */
  shellStableMs: number;
  /** `agent_pane_busy` retry on `agent.start`: bounded 10 × 500 ms (fact 5). */
  agentBusyRetries: number;
  agentBusyRetryMs: number;
  /** `agent.start {timeout_ms}`; HerdR requires 3000 < x <= 300000. */
  agentStartTimeoutMs: number;
  /** `agent.wait` readiness timeout after `agent.start`. */
  readyTimeoutMs: number;
  /** Soft stop confirmation via `pane.process_info` (fact 7). */
  stopPollAttempts: number;
  stopPollIntervalMs: number;
  /** Resubscribe backoff after EOF (fact 4). */
  resubscribeDelayMs: number;
  resubscribeMaxDelayMs: number;
  /** Lines kept by `pane.read`/`pane.output_matched` for the shell sentinel. */
  sentinelLines: number;
  /** Shell kind: `pane.process_info` poll interval while waiting for the command to finish. */
  shellCompletionPollMs: number;
  /** Shell kind: reads of the pane after the sentinel line was typed before giving up (unknown). */
  sentinelReadAttempts: number;
}

export const DEFAULT_TIMING: HerdrTiming = {
  requestTimeoutMs: 10_000,
  connectTimeoutMs: 2_000,
  shellReadyAttempts: 120,
  shellReadyIntervalMs: 250,
  shellStableMs: 750,
  agentBusyRetries: 10,
  agentBusyRetryMs: 500,
  agentStartTimeoutMs: 60_000,
  readyTimeoutMs: 120_000,
  stopPollAttempts: 20,
  stopPollIntervalMs: 250,
  resubscribeDelayMs: 250,
  resubscribeMaxDelayMs: 5_000,
  sentinelLines: 200,
  shellCompletionPollMs: 250,
  sentinelReadAttempts: 40,
};

export interface HerdrAdapterOptions {
  /** Explicit socket path; wins over everything. */
  socketPath?: string;
  /** Named HerdR session; defaults to `mimir` (never the user's default session). */
  sessionName?: string;
  /** Resolve from HERDR_SOCKET_PATH/HERDR_SESSION instead of the `mimir` default when no path/name is given. */
  useEnvironment?: boolean;
  client?: HerdrSocketClient;
  bindings?: BindingStore;
  now?: () => Date;
  timing?: Partial<HerdrTiming>;
}

type Handler = (e: RuntimeEvent) => void;

interface Live {
  state: RuntimeSessionState;
  runtimeStatus?: string;
  lastObservedAt: string;
  lastSeq?: number;
  released?: boolean;
  terminalId?: string;
}

interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  cwd?: string | null;
  agent?: string | null;
  agent_status: string;
  agent_session?: { value?: string } | null;
  revision?: number;
  tokens?: Record<string, string>;
}

interface Snapshot {
  version: string;
  protocol: number;
  panes: PaneInfo[];
}

interface ProcessInfo {
  pane_id: string;
  shell_pid?: number | null;
  foreground_process_group_id?: number | null;
  foreground_processes?: { pid: number; name: string }[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isHerdrCode(e: unknown, ...codes: string[]): boolean {
  return e instanceof HerdrError && codes.includes(e.code);
}

/** True when the pane's foreground process group is the shell itself (no job running). */
/**
 * True when the shell is the only foreground process. Live 0.9.4: while zsh
 * runs startup/prompt hooks the foreground group is still the shell's own, but
 * it has children (printf, zsh subshells) and typed input has not run yet; so
 * the group id alone is not enough.
 */
export function isBareShell(info: ProcessInfo): boolean {
  const procs = info.foreground_processes ?? [];
  const fg = info.foreground_process_group_id;
  if (info.shell_pid == null) return procs.length <= 1;
  if (fg != null && fg !== info.shell_pid) return false;
  return procs.every((p) => p.pid === info.shell_pid);
}

function normalizeCwd(p: string): string {
  const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
  const resolved = path.resolve(expanded);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Result of the fact 8 binding check. `conflict`: nothing HerdR observed proves the pane is or is
 * not ours, but its metadata token names another session. Tokens are writable by any pane
 * (`pane.report_metadata` takes any pane_id and source, audit H4), so a conflict is surfaced as
 * `unknown`, never as `lost`.
 */
export type BindingVerdict = "match" | "mismatch" | "conflict" | "unverified";

/**
 * Fact 8 binding check. HerdR hands out pane ids again (after a restart when the
 * highest workspace was closed, and after a session delete/recreate), so a
 * pane with the bound id is only ours when HerdR-observed facts say so:
 * - it is still the terminal we launched in (`terminal_id`, assigned by HerdR), or
 * - (after a restart) its cwd matches and the agent session id, when both sides
 *   know one, matches; otherwise it is a `mismatch`.
 * The `mimir_session` metadata token is never proof of identity: any pane can
 * write it on any pane. It can only downgrade an unverifiable pane to
 * `conflict`. The env marker MIMIR_SESSION_ID is set too, but HerdR 0.9.4
 * exposes no pane or process environment (`pane.process_info` returns argv,
 * cmdline and cwd only), so it cannot be verified.
 */
export function paneMatchesBinding(
  b: Pick<SessionBinding, "sessionId" | "cwd" | "launchTerminalId" | "agentSessionId">,
  pane: Pick<PaneInfo, "terminal_id" | "cwd" | "tokens" | "agent_session">,
): BindingVerdict {
  if (b.launchTerminalId !== undefined && pane.terminal_id === b.launchTerminalId) return "match";
  if (pane.cwd && normalizeCwd(pane.cwd) !== normalizeCwd(b.cwd)) return "mismatch";
  const agentSession = pane.agent_session?.value;
  if (agentSession && b.agentSessionId && agentSession !== b.agentSessionId) return "mismatch";
  const token = pane.tokens?.[SESSION_TOKEN_KEY];
  if (token !== undefined && token !== b.sessionId) return "conflict";
  return "unverified";
}

const hasControlChar = (v: string) =>
  [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export class HerdrAdapter implements RuntimeAdapter {
  readonly client: HerdrSocketClient;
  readonly bindings: BindingStore;
  readonly timing: HerdrTiming;
  private readonly now: () => Date;
  private readonly live = new Map<string, Live>();
  private readonly handlers = new Set<Handler>();
  private readonly chains = new Map<string, Promise<void>>();
  private ingress: Promise<void> = Promise.resolve();
  private readonly paneSubs = new Map<string, HerdrSubscription | "pending">();
  private readonly shellWatches = new Set<string>();
  private lifecycleSub: HerdrSubscription | null = null;
  private monitorActive = false;
  private generation = 0;
  private disposed = false;

  constructor(opts: HerdrAdapterOptions = {}) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    const socketPath = resolveSocketPath({
      socketPath: opts.socketPath,
      sessionName: opts.sessionName ?? (opts.useEnvironment ? undefined : "mimir"),
    });
    this.client =
      opts.client ??
      new HerdrSocketClient(socketPath, {
        requestTimeoutMs: this.timing.requestTimeoutMs,
        connectTimeoutMs: this.timing.connectTimeoutMs,
      });
    this.bindings = opts.bindings ?? new JsonFileBindingStore(defaultBindingsPath());
    this.now = opts.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ basics

  async capabilities(): Promise<RuntimeCapabilities> {
    const pong = await this.call<{ version: string; protocol: number }>("ping");
    const snap = await this.snapshot();
    return {
      runtime: "herdr",
      version: snap.version || pong.version,
      features: {
        createSession: true,
        sendInput: true,
        sendKeys: true,
        softStop: true,
        forceStop: true,
        pause: false,
        subscribe: true,
        terminalRead: true,
        processInfo: true,
        multiHost: false,
        notify: false,
      },
      agentKinds: [...HERDR_AGENT_KINDS, SHELL_AGENT_KIND],
    };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const pong = await this.client.request<{ version: string; protocol: number }>(
        "ping",
        {},
        {
          timeoutMs: Math.min(this.timing.requestTimeoutMs, 3_000),
        },
      );
      if (pong.protocol !== HERDR_PROTOCOL) {
        return {
          ok: false,
          detail: `protocol_mismatch: herdr ${pong.version} speaks protocol ${pong.protocol}, adapter expects ${HERDR_PROTOCOL}`,
        };
      }
      return {
        ok: true,
        detail: `herdr ${pong.version} protocol ${pong.protocol} at ${this.client.socketPath}`,
      };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // ------------------------------------------------------------ sessions

  async createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    this.assertNotDisposed();
    const existing = await this.bindings.get(spec.idempotencyKey);
    if (existing) {
      return (
        (await this.getSession(existing.sessionId)) ?? this.toSession(existing, undefined, true)
      );
    }
    const isShell = spec.agentKind === SHELL_AGENT_KIND;
    if (spec.argv.some(hasControlChar)) {
      // HerdR rejects these for agent.start too; a newline would submit a shell line early.
      throw new MimirError("validation_failed", "argv must not contain control characters", {
        sessionId: spec.sessionId,
      });
    }
    const created = await this.call<{ root_pane: PaneInfo }>("workspace.create", {
      cwd: spec.cwd,
      env: { ...spec.env, [SESSION_ENV_MARKER]: spec.sessionId },
      label: spec.workspaceLabel,
      focus: false,
    });
    const root = created.root_pane;
    const binding: SessionBinding = {
      sessionId: spec.sessionId,
      idempotencyKey: spec.idempotencyKey,
      paneId: root.pane_id,
      workspaceId: root.workspace_id,
      cwd: spec.cwd,
      agentKind: spec.agentKind,
      launchTerminalId: root.terminal_id,
      createdAt: this.iso(),
    };
    // C1: a reused pane id retires whatever binding held it before.
    for (const stale of await this.bindings.list()) {
      if (stale.paneId === root.pane_id && !stale.lost && stale.sessionId !== spec.sessionId) {
        await this.markLost(stale, "pane_reused");
      }
    }
    await this.bindings.put(binding);
    try {
      // Display/correlation only: any pane can rewrite this token (audit H4), see paneMatchesBinding.
      await this.client.request("pane.report_metadata", {
        pane_id: root.pane_id,
        source: METADATA_SOURCE,
        tokens: { [SESSION_TOKEN_KEY]: spec.sessionId },
      });
    } catch {
      // best effort: binding falls back to terminal id + cwd checks
    }
    this.live.set(spec.sessionId, {
      state: "starting",
      lastObservedAt: this.iso(),
      terminalId: root.terminal_id,
    });
    this.emitState(spec.sessionId);
    if (this.monitorActive) await this.ensurePaneWatch(binding, this.generation);

    try {
      await this.waitForBareShell(root.pane_id);
      if (isShell) await this.launchShell(binding, spec.argv);
      else await this.launchAgent(binding, spec);
    } catch (e) {
      await this.transition(spec.sessionId, "failed", { runtimeStatus: "launch_failed" });
      await this.client.request("pane.close", { pane_id: root.pane_id }).catch(() => undefined);
      throw toMimirError(e);
    }
    return this.toSession(binding, undefined, true);
  }

  /**
   * Fact 5, shell kind: `pane.send_text` + Enter. The command line carries no sentinel and no
   * nonce (audit H4: a typed nonce sits in scrollback and history, where the running command
   * could read it and fake its exit). The exit status is kept in a shell variable; the sentinel
   * line is typed by `watchShell` only once the command is gone.
   */
  private async launchShell(binding: SessionBinding, argv: string[]): Promise<void> {
    const command = argv.map(shellQuote).join(" ");
    const text = `${command}; ${SHELL_RC_VAR}=$?`;
    await this.call("pane.send_text", { pane_id: binding.paneId, text });
    await this.call("pane.send_keys", { pane_id: binding.paneId, keys: ["enter"] });
    await this.transition(binding.sessionId, "running", { runtimeStatus: "shell_command" });
    this.startShellWatch(binding);
  }

  private startShellWatch(b: SessionBinding): void {
    if (this.disposed || this.shellWatches.has(b.sessionId)) return;
    this.shellWatches.add(b.sessionId);
    void this.watchShell(b.sessionId)
      .catch(() => undefined)
      .finally(() => this.shellWatches.delete(b.sessionId));
  }

  /**
   * Shell kind completion. Poll `pane.process_info` until the shell has been the sole
   * foreground process for `shellStableMs`; only then mint the nonce and type the single
   * sentinel line (` echo MIMIR_DONE:<id>:<nonce>:$__mimir_rc`, leading space so shells with
   * ignorespace keep it out of history). Completion is accepted only from a line with that
   * nonce while the shell is again the sole foreground process.
   */
  private async watchShell(sessionId: string): Promise<void> {
    let bareSince: number | null = null;
    let reads = 0;
    while (!this.disposed) {
      const b = await this.bindings.getBySessionId(sessionId);
      if (!b || b.lost || b.finalState) return;
      const live = this.live.get(sessionId);
      if (live && TERMINAL_STATES.has(live.state)) return;
      if (live?.state === "stopping") {
        bareSince = null;
        await sleep(this.timing.shellCompletionPollMs);
        continue;
      }
      let info: ProcessInfo;
      try {
        info = await this.processInfo(b.paneId);
      } catch (e) {
        if (e instanceof MimirError && e.code === "not_found") return;
        await sleep(this.timing.shellCompletionPollMs);
        continue;
      }
      if (!isBareShell(info)) bareSince = null;
      else if (bareSince === null) bareSince = Date.now();
      if (bareSince !== null && Date.now() - bareSince >= this.timing.shellStableMs) {
        const sealed = b.sentinelNonce ? b : await this.sealShell(b);
        const exit = await this.readSentinel(sealed);
        if (exit !== undefined) {
          await this.enqueue(sessionId, () => this.finishShell(sessionId, exit));
          return;
        }
        if (++reads >= this.timing.sentinelReadAttempts) {
          await this.transition(sessionId, "unknown", { runtimeStatus: "no_sentinel" });
          return;
        }
      }
      await sleep(this.timing.shellCompletionPollMs);
    }
  }

  /** Mints the nonce and types the sentinel line (the command has finished: bare shell). */
  private async sealShell(b: SessionBinding): Promise<SessionBinding> {
    const sealed: SessionBinding = { ...b, sentinelNonce: randomBytes(8).toString("hex") };
    await this.bindings.put(sealed);
    if (this.monitorActive) {
      // Re-subscribe so the output_matched entry carries the exact nonce.
      this.dropPaneWatch(b.paneId);
      await this.ensurePaneWatch(sealed, this.generation);
    }
    const text = ` echo MIMIR_DONE:${b.sessionId}:${sealed.sentinelNonce}:$${SHELL_RC_VAR}`;
    await this.call("pane.send_text", { pane_id: b.paneId, text });
    await this.call("pane.send_keys", { pane_id: b.paneId, keys: ["enter"] });
    return sealed;
  }

  /** Exit code from a sentinel with this binding's nonce, only while the shell is bare. */
  private async readSentinel(b: SessionBinding): Promise<number | undefined> {
    if (!b.sentinelNonce) return undefined;
    const text = await this.call<{ read: { text: string } }>("pane.read", {
      pane_id: b.paneId,
      source: "recent_unwrapped",
      lines: this.timing.sentinelLines,
    });
    const exit = parseSentinel(b.sessionId, b.sentinelNonce, text.read.text);
    if (exit === undefined) return undefined;
    return (await this.shellIsBare(b.paneId)) ? exit : undefined;
  }

  private async shellIsBare(paneId: string): Promise<boolean> {
    try {
      return isBareShell(await this.processInfo(paneId));
    } catch {
      return false;
    }
  }

  /** Fact 5, agent kinds: `agent.start` (retry agent_pane_busy) then `agent.wait {until:[idle,blocked]}`. */
  private async launchAgent(binding: SessionBinding, spec: RuntimeSessionSpec): Promise<void> {
    const args = spec.argv[0] === spec.agentKind ? spec.argv.slice(1) : spec.argv;
    const params = {
      name: spec.sessionId.toLowerCase().slice(0, 32),
      kind: spec.agentKind,
      pane_id: binding.paneId,
      args,
      timeout_ms: this.timing.agentStartTimeoutMs,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.request("agent.start", params);
        break;
      } catch (e) {
        if (!isHerdrCode(e, "agent_pane_busy") || attempt >= this.timing.agentBusyRetries) throw e;
        await sleep(this.timing.agentBusyRetryMs);
      }
    }
    // launch_pending:true — not ready until agent.wait says idle or blocked.
    try {
      const res = await this.client.request<{
        agent: { agent_status: string; state_change_seq?: number };
      }>(
        "agent.wait",
        {
          target: binding.paneId,
          until: ["idle", "blocked"],
          timeout_ms: this.timing.readyTimeoutMs,
        },
        { timeoutMs: this.timing.readyTimeoutMs + this.timing.requestTimeoutMs },
      );
      // Same per-session queue as pushed events, so the returned state includes any in-flight event.
      await this.enqueue(binding.sessionId, () =>
        this.applyAgentStatus(binding, res.agent.agent_status, res.agent.state_change_seq),
      );
    } catch (e) {
      if (isHerdrCode(e, "agent_not_found", "timeout")) return; // already released, or still launching
      throw e;
    }
  }

  /**
   * Live 0.9.4 + zsh: startup alternates short bare-shell windows with helper
   * processes for ~2.5 s, and text typed during startup is lost. Require the
   * shell to stay the only foreground process for `shellStableMs`.
   */
  private async waitForBareShell(paneId: string): Promise<void> {
    let bareSince: number | null = null;
    let last: ProcessInfo | undefined;
    for (let i = 0; i < this.timing.shellReadyAttempts; i++) {
      const info = await this.processInfo(paneId);
      last = info;
      if (!isBareShell(info)) bareSince = null;
      else if (bareSince === null) bareSince = Date.now();
      else if (Date.now() - bareSince >= this.timing.shellStableMs) return;
      await sleep(this.timing.shellReadyIntervalMs);
    }
    throw new MimirError("conflict", `pane ${paneId} never reached a bare shell`, {
      retryable: true,
      paneId,
      lastForeground: last?.foreground_processes?.map((p) => p.name) ?? [],
    });
  }

  async listSessions(): Promise<RuntimeSession[]> {
    const [snap, bindings] = await Promise.all([this.snapshot(), this.bindings.list()]);
    const panes = new Map(snap.panes.map((p) => [p.pane_id, p]));
    return bindings.filter((b) => !b.lost).map((b) => this.toSession(b, panes.get(b.paneId)));
  }

  async getSession(sessionId: string): Promise<RuntimeSession | null> {
    const b = await this.bindings.getBySessionId(sessionId);
    if (!b || b.lost) return null;
    const snap = await this.snapshot();
    return this.toSession(
      b,
      snap.panes.find((p) => p.pane_id === b.paneId),
    );
  }

  /** Fact 10: text only via `agent.prompt` (agent must be idle); keys via `agent.send_keys` / `pane.send_keys`. */
  async sendInput(sessionId: string, input: { text?: string; keys?: string[] }): Promise<void> {
    const b = await this.mustBinding(sessionId);
    const isShell = b.agentKind === SHELL_AGENT_KIND;
    if (input.text !== undefined) {
      if (isShell) await this.call("pane.send_text", { pane_id: b.paneId, text: input.text });
      else await this.call("agent.prompt", { target: b.paneId, text: input.text });
    }
    if (input.keys?.length) {
      if (isShell) {
        await this.call("pane.send_keys", { pane_id: b.paneId, keys: input.keys });
      } else {
        try {
          await this.client.request("agent.send_keys", { target: b.paneId, keys: input.keys });
        } catch (e) {
          if (!isHerdrCode(e, "agent_not_found")) throw toMimirError(e);
          await this.call("pane.send_keys", { pane_id: b.paneId, keys: input.keys });
        }
      }
    }
  }

  /** Reads the pane screen (`pane.read`); works after an agent released the pane (fact 6). */
  async readTerminal(sessionId: string, lines = 200): Promise<string> {
    const b = await this.mustBinding(sessionId);
    const res = await this.call<{ read: { text: string } }>("pane.read", {
      pane_id: b.paneId,
      source: "recent",
      lines,
    });
    return res.read.text;
  }

  /** Fact 7: soft = Ctrl-C then confirm with `pane.process_info`; force = `pane.close`. */
  async requestStop(sessionId: string, mode: "soft" | "force"): Promise<void> {
    const b = await this.mustBinding(sessionId);
    if (mode === "force") {
      this.dropPaneWatch(b.paneId);
      try {
        await this.client.request("pane.close", { pane_id: b.paneId });
      } catch (e) {
        if (!isHerdrCode(e, "pane_not_found")) throw toMimirError(e);
      }
      await this.transition(sessionId, "stopped", { runtimeStatus: "force_closed" });
      return;
    }
    const current = this.live.get(sessionId)?.state ?? b.finalState;
    if (current && TERMINAL_STATES.has(current)) return;
    const before = this.live.get(sessionId);
    const priorState = before?.state ?? "unknown";
    await this.transition(sessionId, "stopping", { runtimeStatus: "ctrl_c_sent" });
    await this.call("pane.send_keys", { pane_id: b.paneId, keys: ["ctrl+c"] });
    const half = Math.ceil(this.timing.stopPollAttempts / 2);
    for (let i = 1; i <= this.timing.stopPollAttempts; i++) {
      await sleep(this.timing.stopPollIntervalMs);
      let info: ProcessInfo;
      try {
        info = await this.processInfo(b.paneId);
      } catch (e) {
        if (!(e instanceof MimirError && e.code === "not_found")) throw e;
        await this.transition(sessionId, "stopped", { runtimeStatus: "pane_gone" });
        return;
      }
      if (isBareShell(info)) {
        const state = this.live.get(sessionId)?.state;
        if (state === "stopping" || (state && !TERMINAL_STATES.has(state))) {
          await this.transition(sessionId, "stopped", { runtimeStatus: "process_exited" });
        }
        return;
      }
      // Interactive agents (claude) ask for a second Ctrl-C.
      if (i === half) await this.call("pane.send_keys", { pane_id: b.paneId, keys: ["ctrl+c"] });
    }
    // Not confirmed: go back to the last observed state so later status events are not ignored.
    if (this.live.get(sessionId)?.state === "stopping") {
      await this.transition(sessionId, priorState, { runtimeStatus: "stop_unconfirmed" });
    }
    throw new MimirError(
      "conflict",
      `soft stop of ${sessionId} not confirmed: a foreground process is still running`,
      {
        retryable: true,
        reason: "stop_unconfirmed",
        paneId: b.paneId,
      },
    );
  }

  /** Snapshot + `pane.process_info` per bound session → current sessions and confirmed losses. */
  async reconcile(): Promise<{ sessions: RuntimeSession[]; lost: string[] }> {
    const [snap, bindings] = await Promise.all([this.snapshot(), this.bindings.list()]);
    const panes = new Map(snap.panes.map((p) => [p.pane_id, p]));
    const sessions: RuntimeSession[] = [];
    const lost: string[] = [];
    for (const b of bindings) {
      if (b.lost) {
        lost.push(b.sessionId);
        continue;
      }
      const pane = panes.get(b.paneId);
      const identity = pane ? paneMatchesBinding(b, pane) : "unverified";
      if (identity === "mismatch") {
        await this.markLost(b, "pane_reused");
        lost.push(b.sessionId);
        continue;
      }
      if (identity === "conflict") {
        // A token alone never proves anything (audit H4): surface it, do not adopt the pane.
        if (!b.finalState)
          await this.transition(b.sessionId, "unknown", { runtimeStatus: "marker_conflict" });
        sessions.push(this.toSession(b, undefined));
        continue;
      }
      if (b.finalState) {
        if (pane && pane.terminal_id !== b.launchTerminalId)
          await this.bindings.put({ ...b, launchTerminalId: pane.terminal_id });
        sessions.push(this.toSession(b, pane));
        continue;
      }
      let info: ProcessInfo | null = null;
      try {
        info = await this.processInfo(b.paneId);
      } catch (e) {
        if (!(e instanceof MimirError && e.code === "not_found")) throw e;
      }
      if (!pane || !info) {
        if (!info) {
          await this.markLost(b, "pane_not_found");
          lost.push(b.sessionId);
        } else {
          sessions.push(this.toSession(b, pane));
        }
        continue;
      }
      const verdict = await this.reconcileLivePane(b, pane, info);
      if (verdict === "lost") {
        lost.push(b.sessionId);
        continue;
      }
      const fresh = (await this.bindings.getBySessionId(b.sessionId)) ?? b;
      sessions.push(this.toSession(fresh, pane));
    }
    return { sessions, lost };
  }

  private async reconcileLivePane(
    b: SessionBinding,
    pane: PaneInfo,
    info: ProcessInfo,
  ): Promise<"ok" | "lost"> {
    const restarted = b.launchTerminalId !== undefined && pane.terminal_id !== b.launchTerminalId;
    const bare = isBareShell(info);
    if (b.agentKind === SHELL_AGENT_KIND) {
      // Fact 8: HerdR never restores a pane's process across stop/start. After a
      // restart only the sentinel can prove the command finished; whatever runs
      // in the restored shell (startup hooks) is not our command.
      if (!bare && !restarted) {
        await this.transition(b.sessionId, "running", { runtimeStatus: "foreground_process" });
        return "ok";
      }
      if (b.sentinelNonce) {
        const text = await this.call<{ read: { text: string } }>("pane.read", {
          pane_id: b.paneId,
          source: "recent_unwrapped",
          lines: this.timing.sentinelLines,
        });
        // Restored scrollback after a restart predates the new shell; otherwise the shell is
        // bare here (checked above), so the sentinel is bound to a finished command.
        const exit = parseSentinel(b.sessionId, b.sentinelNonce, text.read.text);
        if (exit !== undefined) {
          if (restarted) await this.bindings.put({ ...b, launchTerminalId: pane.terminal_id });
          await this.finishShell(b.sessionId, exit);
          return "ok";
        }
      }
      if (restarted) {
        await this.markLost(b, "restart: process not restored");
        return "lost";
      }
      // Bare shell, no sentinel yet: the watcher types it (or is already waiting for it).
      this.startShellWatch(b);
      return "ok";
    }
    if (pane.agent) {
      if (restarted) await this.bindings.put({ ...b, launchTerminalId: pane.terminal_id });
      await this.applyAgentStatus(b, pane.agent_status, undefined);
      return "ok";
    }
    if (restarted) {
      await this.markLost(b, "restart: agent not restored");
      return "lost";
    }
    if (!bare)
      await this.transition(b.sessionId, "running", { runtimeStatus: "foreground_process" });
    return "ok";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopMonitor();
    this.handlers.clear();
  }

  // ------------------------------------------------------------ subscribe

  /**
   * Bootstrap (fact 2/4): lifecycle subscription first, then `session.snapshot`,
   * then one status subscription per bound pane, then the current states.
   * Any EOF → `runtime.gap`, resubscribe, re-snapshot, re-emit bound sessions.
   */
  async subscribe(handler: Handler): Promise<{ close(): void }> {
    this.assertNotDisposed();
    this.handlers.add(handler);
    if (!this.monitorActive) {
      this.monitorActive = true;
      try {
        await this.bootstrap(this.generation);
      } catch (e) {
        this.handlers.delete(handler);
        this.stopMonitor();
        throw toMimirError(e);
      }
    } else {
      for (const sessionId of this.live.keys()) this.emitState(sessionId, handler);
    }
    return {
      close: () => {
        this.handlers.delete(handler);
        if (this.handlers.size === 0) this.stopMonitor();
      },
    };
  }

  private stopMonitor(): void {
    this.monitorActive = false;
    this.generation++;
    this.closeAllSubs();
  }

  private closeAllSubs(): void {
    this.lifecycleSub?.close();
    this.lifecycleSub = null;
    for (const s of this.paneSubs.values()) if (s !== "pending") s.close();
    this.paneSubs.clear();
  }

  private async bootstrap(gen: number): Promise<void> {
    const sub = await this.client.subscribe([...LIFECYCLE_SUBSCRIPTIONS], (e) =>
      this.onEnvelope(e, gen),
    );
    if (gen !== this.generation) {
      sub.close();
      return;
    }
    this.lifecycleSub = sub;
    void sub.closed.then((info) => this.onSubClosed(info, gen));
    const [snap, bindings] = await Promise.all([this.snapshot(), this.bindings.list()]);
    if (gen !== this.generation) return;
    const panes = new Map(snap.panes.map((p) => [p.pane_id, p]));
    for (const b of bindings) {
      if (b.lost) continue;
      const pane = panes.get(b.paneId);
      const verdict = pane ? paneMatchesBinding(b, pane) : "unverified";
      if (verdict === "mismatch") {
        await this.markLost(b, "pane_reused");
        b.lost = true;
        continue;
      }
      const live = this.ensureLive(b);
      if (verdict === "conflict") {
        if (!TERMINAL_STATES.has(live.state)) {
          live.state = "unknown";
          live.runtimeStatus = "marker_conflict";
          live.lastObservedAt = this.iso();
        }
        continue;
      }
      if (pane) live.terminalId = pane.terminal_id;
      if (!TERMINAL_STATES.has(live.state)) {
        if (!pane) {
          live.state = "unknown";
          live.runtimeStatus = "pane_missing";
        } else if (b.agentKind !== SHELL_AGENT_KIND && (pane.agent || live.state !== "starting")) {
          live.state = mapAgentStatus(pane.agent_status);
          live.runtimeStatus = pane.agent_status;
        }
        live.lastObservedAt = this.iso();
        if (pane) await this.ensurePaneWatch(b, gen);
        if (pane && b.agentKind === SHELL_AGENT_KIND) this.startShellWatch(b);
      }
    }
    if (gen !== this.generation) return;
    for (const b of bindings) if (!b.lost) this.emitState(b.sessionId);
  }

  private async ensurePaneWatch(b: SessionBinding, gen: number): Promise<void> {
    if (this.paneSubs.has(b.paneId) || !this.monitorActive) return;
    this.paneSubs.set(b.paneId, "pending");
    const specs: { type: string; [k: string]: unknown }[] = [
      { type: "pane.agent_status_changed", pane_id: b.paneId },
    ];
    if (b.agentKind === SHELL_AGENT_KIND && b.sentinelNonce) {
      specs.push({
        type: "pane.output_matched",
        pane_id: b.paneId,
        source: "recent_unwrapped",
        lines: this.timing.sentinelLines,
        match: { type: "regex", value: sentinelRegex(b.sessionId, b.sentinelNonce) },
      });
    }
    let sub: HerdrSubscription;
    try {
      sub = await this.client.subscribe(specs, (e) => this.onEnvelope(e, gen));
    } catch (e) {
      if (this.paneSubs.get(b.paneId) === "pending") this.paneSubs.delete(b.paneId);
      if (isHerdrCode(e, "pane_not_found")) {
        // Pane vanished between snapshot and subscribe: drop it; reconcile decides if it is lost.
        const live = this.live.get(b.sessionId);
        if (live && !TERMINAL_STATES.has(live.state))
          await this.transition(b.sessionId, "unknown", { runtimeStatus: "pane_missing" });
        return;
      }
      if (gen === this.generation)
        this.onSubClosed(
          e instanceof HerdrError ? { reason: "error", error: e } : { reason: "error" },
          gen,
        );
      return;
    }
    if (gen !== this.generation || this.paneSubs.get(b.paneId) !== "pending") {
      sub.close();
      return;
    }
    this.paneSubs.set(b.paneId, sub);
    void sub.closed.then((info) => this.onSubClosed(info, gen));
    // I1: HerdR sends no initial event for an unfiltered status subscription, so a
    // change between the snapshot and this ack would be lost. Read it now.
    if (b.agentKind !== SHELL_AGENT_KIND) {
      void this.enqueue(b.sessionId, async () => {
        if (gen !== this.generation) return;
        try {
          const got = await this.client.request<{
            agent: { agent_status: string; state_change_seq?: number };
          }>("agent.get", { target: b.paneId });
          await this.applyAgentStatus(b, got.agent.agent_status, got.agent.state_change_seq);
        } catch {
          // agent_not_found (released or not started): nothing to apply
        }
      });
    }
  }

  private dropPaneWatch(paneId: string): void {
    const s = this.paneSubs.get(paneId);
    this.paneSubs.delete(paneId);
    if (s && s !== "pending") s.close();
  }

  private onSubClosed(info: CloseInfo, gen: number): void {
    if (info.reason === "closed_by_client" || gen !== this.generation || !this.monitorActive)
      return;
    const next = ++this.generation;
    this.closeAllSubs();
    this.emit({
      kind: "runtime.gap",
      reason: info.error?.code === "events_lost" ? "events_lost" : "reconnect",
      observedAt: this.iso(),
    });
    void this.rebootstrap(next);
  }

  private async rebootstrap(gen: number): Promise<void> {
    let wait = this.timing.resubscribeDelayMs;
    while (this.monitorActive && gen === this.generation) {
      await sleep(wait);
      if (!this.monitorActive || gen !== this.generation) return;
      try {
        await this.bootstrap(gen);
        return;
      } catch {
        this.lifecycleSub?.close();
        this.lifecycleSub = null;
        wait = Math.min(wait * 2, this.timing.resubscribeMaxDelayMs);
      }
    }
  }

  private onEnvelope(e: HerdrEnvelope, gen: number): void {
    if (gen !== this.generation) return;
    const paneId =
      typeof e.data.pane_id === "string"
        ? e.data.pane_id
        : (e.data.pane as PaneInfo | undefined)?.pane_id;
    if (!paneId) return;
    // One ingress chain keeps arrival order while the binding lookup is async.
    this.ingress = this.ingress
      .then(async () => {
        if (e.event === "pane_created") {
          // A restored pane emits pane_updated, never pane_created (fact 8): a new
          // terminal at a bound pane id means the id was reused (C1).
          const created = e.data.pane as PaneInfo | undefined;
          for (const stale of await this.bindings.list()) {
            if (
              stale.paneId === paneId &&
              !stale.lost &&
              stale.launchTerminalId !== undefined &&
              created &&
              created.terminal_id !== stale.launchTerminalId
            ) {
              await this.markLost(stale, "pane_reused");
            }
          }
        }
        const b = await this.bindingForPane(paneId);
        if (b && !b.lost) void this.enqueue(b.sessionId, () => this.handleEnvelope(b, e, gen));
      })
      .catch(() => undefined);
  }

  private async handleEnvelope(b: SessionBinding, e: HerdrEnvelope, gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const live = this.ensureLive(b);
    const terminal = TERMINAL_STATES.has(live.state);
    const isShell = b.agentKind === SHELL_AGENT_KIND;
    switch (e.event) {
      case "pane_created":
        if (!terminal) await this.ensurePaneWatch(b, gen);
        return;
      case "pane_updated": {
        const pane = e.data.pane as PaneInfo;
        live.terminalId = pane.terminal_id;
        const agentSessionId = pane.agent_session?.value;
        if (agentSessionId && agentSessionId !== b.agentSessionId)
          await this.bindings.put({ ...b, agentSessionId });
        return;
      }
      case "pane_agent_detected":
        if (isShell || e.data.released !== true) return;
        live.released = true;
        if (!terminal) {
          await this.transition(
            b.sessionId,
            live.state === "stopping" ? "stopped" : releaseState(e.data.final_status),
            {
              runtimeStatus: `released:${String(e.data.final_status ?? "unknown")}`,
            },
          );
        }
        return;
      case "pane_closed":
        this.dropPaneWatch(b.paneId);
        if (!terminal)
          await this.transition(b.sessionId, "unknown", { runtimeStatus: "pane_closed" });
        return;
      case "pane_exited":
        if (terminal) return;
        this.emit({ kind: "session.exited", sessionId: b.sessionId, observedAt: this.iso() });
        await this.transition(b.sessionId, "failed", { runtimeStatus: "pane_exited" });
        return;
      case "pane.agent_status_changed": {
        if (isShell || terminal) return;
        const status = String(e.data.agent_status);
        if (status === "unknown" && live.released) return;
        // Events carry no sequence (fact 3): read status and state_change_seq together via agent.get,
        // so a late event can never pair an old status with a newer seq.
        let seq: number | undefined;
        let current = status;
        try {
          const got = await this.client.request<{
            agent: { state_change_seq?: number; agent_status: string };
          }>("agent.get", {
            target: b.paneId,
          });
          seq = got.agent.state_change_seq;
          current = got.agent.agent_status;
        } catch {
          seq = undefined;
        }
        await this.applyAgentStatus(b, current, seq);
        return;
      }
      case "pane.output_matched": {
        if (!isShell || terminal) return;
        // Shell kind only: the brief-mandated exception to "terminal text never sets state".
        const exit = parseSentinel(b.sessionId, b.sentinelNonce, String(e.data.matched_line ?? ""));
        // Bound to process state: a line printed by a running foreground process is not ours.
        if (exit !== undefined && (await this.shellIsBare(b.paneId)))
          await this.finishShell(b.sessionId, exit);
        return;
      }
      default:
        return;
    }
  }

  /** Status → state, `(pane_id, state_change_seq)` as sourceEventId (fact 3), trust-prompt detection (fact 9). */
  private async applyAgentStatus(
    b: SessionBinding,
    status: string,
    seq: number | undefined,
  ): Promise<void> {
    const live = this.ensureLive(b);
    // Terminal states are sticky; while stopping, `idle` after Ctrl-C proves nothing (fact 7).
    if (TERMINAL_STATES.has(live.state) || live.state === "stopping") return;
    const observedAt = this.iso();
    if (seq !== undefined && live.lastSeq !== undefined && seq <= live.lastSeq) return; // duplicate/stale
    if (seq !== undefined) live.lastSeq = seq;
    const sourceEventId =
      seq !== undefined ? `${b.paneId}:${seq}` : `${b.paneId}:${observedAt}:${status}`;
    let runtimeStatus = status;
    if (status === "blocked") {
      try {
        const read = await this.client.request<{ read: { text: string } }>("pane.read", {
          pane_id: b.paneId,
          source: "visible",
        });
        if (isTrustPrompt(read.read.text)) runtimeStatus = TRUST_PROMPT_STATUS;
      } catch {
        // screen unavailable: plain blocked
      }
    }
    await this.transition(b.sessionId, mapAgentStatus(status), { runtimeStatus, sourceEventId });
  }

  private async finishShell(sessionId: string, exitCode: number): Promise<void> {
    const live = this.live.get(sessionId);
    if (live && TERMINAL_STATES.has(live.state)) return;
    const state: RuntimeSessionState =
      live?.state === "stopping" ? "stopped" : exitCode === 0 ? "completed" : "failed";
    await this.transition(sessionId, state, { runtimeStatus: `exit:${exitCode}`, exitCode });
    this.emit({ kind: "session.exited", sessionId, exitCode, observedAt: this.iso() });
  }

  private async markLost(b: SessionBinding, reason: string): Promise<void> {
    const current = await this.bindings.get(b.idempotencyKey);
    if (!current || current.lost) return;
    // Only drop the pane watch when no newer binding owns this pane id.
    const owner = await this.bindingForPane(b.paneId);
    if (!owner || owner.sessionId === b.sessionId) this.dropPaneWatch(b.paneId);
    await this.bindings.put({ ...current, lost: true });
    this.live.delete(b.sessionId);
    this.emit({ kind: "session.lost", sessionId: b.sessionId, reason, observedAt: this.iso() });
  }

  // ------------------------------------------------------------ helpers

  private async transition(
    sessionId: string,
    state: RuntimeSessionState,
    opts: { runtimeStatus?: string; sourceEventId?: string; exitCode?: number } = {},
  ): Promise<void> {
    const prev = this.live.get(sessionId);
    if (prev && TERMINAL_STATES.has(prev.state)) return;
    if (
      prev &&
      prev.state === state &&
      prev.runtimeStatus === opts.runtimeStatus &&
      !opts.sourceEventId
    )
      return;
    const live: Live = { ...(prev ?? {}), state, lastObservedAt: this.iso() };
    if (opts.runtimeStatus !== undefined) live.runtimeStatus = opts.runtimeStatus;
    else delete live.runtimeStatus;
    this.live.set(sessionId, live);
    if (TERMINAL_STATES.has(state)) {
      const b = await this.bindings.getBySessionId(sessionId);
      if (b) {
        const next: SessionBinding = { ...b, finalState: state };
        if (opts.exitCode !== undefined) next.exitCode = opts.exitCode;
        await this.bindings.put(next);
      }
    }
    this.emitState(sessionId, undefined, opts.sourceEventId);
  }

  private emitState(sessionId: string, only?: Handler, sourceEventId?: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const e: RuntimeEvent = {
      kind: "session.state_changed",
      sessionId,
      state: live.state,
      observedAt: live.lastObservedAt,
    };
    if (live.runtimeStatus !== undefined) e.runtimeStatus = live.runtimeStatus;
    if (sourceEventId !== undefined) e.sourceEventId = sourceEventId;
    if (only) safeCall(only, e);
    else this.emit(e);
  }

  private emit(e: RuntimeEvent): void {
    for (const h of [...this.handlers]) safeCall(h, e);
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch(() => undefined);
    this.chains.set(sessionId, next);
    return next;
  }

  private ensureLive(b: SessionBinding): Live {
    let live = this.live.get(b.sessionId);
    if (!live) {
      live = { state: b.finalState ?? "unknown", lastObservedAt: this.iso() };
      this.live.set(b.sessionId, live);
    }
    return live;
  }

  private async bindingForPane(paneId: string): Promise<SessionBinding | undefined> {
    // Newest live binding wins: older ones at a reused id are retired (C1).
    const all = (await this.bindings.list()).filter((b) => b.paneId === paneId && !b.lost);
    return all
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0))
      .at(-1);
  }

  /** `fromLive`: no snapshot was taken; trust the adapter's own last observation. */
  private toSession(
    b: SessionBinding,
    pane: PaneInfo | undefined,
    fromLive = false,
  ): RuntimeSession {
    const live = this.live.get(b.sessionId);
    let state: RuntimeSessionState;
    if (b.finalState) state = b.finalState;
    else if (live && (TERMINAL_STATES.has(live.state) || fromLive)) state = live.state;
    else if (!pane) state = "unknown";
    else if (b.agentKind !== SHELL_AGENT_KIND && pane.agent)
      state = mapAgentStatus(pane.agent_status);
    else state = live?.state ?? "unknown";
    const runtimeRef: RuntimeSession["runtimeRef"] = {
      paneId: b.paneId,
      workspaceId: b.workspaceId,
    };
    const terminalId = pane?.terminal_id ?? live?.terminalId ?? b.launchTerminalId;
    if (terminalId) runtimeRef.terminalId = terminalId;
    const agentSessionId = b.agentSessionId ?? pane?.agent_session?.value;
    if (agentSessionId) runtimeRef.agentSessionId = agentSessionId;
    return {
      sessionId: b.sessionId,
      runtimeRef,
      state,
      agentKind: b.agentKind,
      cwd: b.cwd,
      lastObservedAt: live?.lastObservedAt ?? this.iso(),
    };
  }

  private async mustBinding(sessionId: string): Promise<SessionBinding> {
    const b = await this.bindings.getBySessionId(sessionId);
    if (!b || b.lost)
      throw new MimirError("not_found", `no HerdR session bound to ${sessionId}`, { sessionId });
    return b;
  }

  private async snapshot(): Promise<Snapshot> {
    const res = await this.call<{ snapshot: Snapshot }>("session.snapshot");
    return res.snapshot;
  }

  private async processInfo(paneId: string): Promise<ProcessInfo> {
    const res = await this.call<{ process_info: ProcessInfo }>("pane.process_info", {
      pane_id: paneId,
    });
    return res.process_info;
  }

  private async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (e) {
      throw toMimirError(e);
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private assertNotDisposed(): void {
    if (this.disposed)
      throw new MimirError("runtime_unavailable", "HerdrAdapter has been disposed");
  }
}

function safeCall(h: Handler, e: RuntimeEvent): void {
  try {
    h(e);
  } catch {
    // a failing consumer must not break the adapter
  }
}
