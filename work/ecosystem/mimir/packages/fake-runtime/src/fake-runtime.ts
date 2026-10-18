import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
  type RuntimeSessionState,
} from "@mimir/protocol";

/** Deterministic clock: time only moves when `advance` is called. */
export class ManualClock {
  private current: number;
  private seq = 0;
  private tasks: { due: number; seq: number; fn: () => void }[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Schedules `fn` after `ms`; returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void {
    const task = { due: this.current + ms, seq: this.seq++, fn };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  }

  /** Moves time forward, running due tasks in (time, insertion) order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: (typeof this.tasks)[number] | undefined;
      for (const t of this.tasks) {
        if (
          t.due <= target &&
          (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))
        ) {
          next = t;
        }
      }
      if (!next) break;
      this.tasks = this.tasks.filter((t) => t !== next);
      this.current = next.due;
      next.fn();
    }
    this.current = target;
  }
}

export interface ScriptStep {
  /** Milliseconds after session creation. */
  afterMs: number;
  state?: RuntimeSessionState;
  output?: string;
  exit?: number;
}

export const DEFAULT_SCRIPT: readonly ScriptStep[] = [
  { afterMs: 100, state: "running" },
  { afterMs: 100, output: "working..." },
  { afterMs: 500, state: "idle" },
  { afterMs: 600, state: "completed", exit: 0 },
];

export interface FakeRuntimeOptions {
  clock?: ManualClock;
  script?: readonly ScriptStep[];
}

export interface ChaosOptions {
  /** Silently drop the next n emitted events (state still changes). */
  dropNextEvents?: number;
  /** Emit a `runtime.gap` (events_lost) event right now. */
  emitGap?: boolean;
}

interface Entry {
  session: RuntimeSession;
  spec: RuntimeSessionSpec;
  eventSeq: number;
  cancels: (() => void)[];
  lost: boolean;
  /** What the session's terminal shows: scripted output and operator input lines. */
  terminal: string[];
}

const SOFT_STOP_MS = 50;

export class FakeRuntime implements RuntimeAdapter {
  readonly clock: ManualClock;
  /** Inspectable log of input sent to each session. */
  readonly inputs: Record<string, { text?: string; keys?: string[] }[]> = {};
  private readonly script: readonly ScriptStep[];
  private readonly entries = new Map<string, Entry>();
  private readonly byKey = new Map<string, Entry>();
  private handlers = new Set<(e: RuntimeEvent) => void>();
  private dropRemaining = 0;

  constructor(options: FakeRuntimeOptions = {}) {
    this.clock = options.clock ?? new ManualClock();
    this.script = options.script ?? DEFAULT_SCRIPT;
  }

  capabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve({
      runtime: "fake",
      version: "0.0.0",
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
        notify: true,
      },
      agentKinds: ["claude", "codex", "shell"],
    });
  }

  health(): Promise<{ ok: boolean; detail?: string }> {
    return Promise.resolve({ ok: true });
  }

  createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    const existing = this.byKey.get(spec.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) {
        return Promise.reject(
          new MimirError("conflict", "idempotency key reused with a different spec", {
            idempotencyKey: spec.idempotencyKey,
          }),
        );
      }
      return Promise.resolve({ ...existing.session });
    }
    const entry: Entry = {
      spec,
      eventSeq: 0,
      cancels: [],
      lost: false,
      terminal: [],
      session: {
        sessionId: spec.sessionId,
        runtimeRef: { paneId: `fake:${spec.sessionId}` },
        state: "starting",
        agentKind: spec.agentKind,
        cwd: spec.cwd,
        lastObservedAt: this.iso(),
      },
    };
    this.entries.set(spec.sessionId, entry);
    this.byKey.set(spec.idempotencyKey, entry);
    this.inputs[spec.sessionId] = [];
    for (const step of this.script) {
      entry.cancels.push(this.clock.setTimeout(() => this.runStep(entry, step), step.afterMs));
    }
    return Promise.resolve({ ...entry.session });
  }

  listSessions(): Promise<RuntimeSession[]> {
    return Promise.resolve(this.liveEntries().map((e) => ({ ...e.session })));
  }

  getSession(sessionId: string): Promise<RuntimeSession | null> {
    const e = this.entries.get(sessionId);
    return Promise.resolve(e && !e.lost ? { ...e.session } : null);
  }

  sendInput(sessionId: string, input: { text?: string; keys?: string[] }): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.reject(new MimirError("not_found", `unknown session ${sessionId}`));
    (this.inputs[sessionId] ??= []).push(input);
    if (input.text !== undefined) entry.terminal.push(`> ${input.text}`);
    if (entry.session.state === "blocked") this.setState(entry, "running");
    return Promise.resolve();
  }

  subscribe(handler: (e: RuntimeEvent) => void): Promise<{ close(): void }> {
    this.handlers.add(handler);
    return Promise.resolve({
      close: () => {
        this.handlers.delete(handler);
      },
    });
  }

  requestStop(sessionId: string, mode: "soft" | "force"): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.reject(new MimirError("not_found", `unknown session ${sessionId}`));
    this.cancelScript(entry);
    if (mode === "force") {
      this.setState(entry, "stopped");
    } else {
      this.setState(entry, "stopping");
      entry.cancels.push(
        this.clock.setTimeout(() => this.setState(entry, "stopped"), SOFT_STOP_MS),
      );
    }
    return Promise.resolve();
  }

  reconcile(): Promise<{ sessions: RuntimeSession[]; lost: string[] }> {
    const lost = [...this.entries.values()].filter((e) => e.lost).map((e) => e.session.sessionId);
    return Promise.resolve({ sessions: this.liveEntries().map((e) => ({ ...e.session })), lost });
  }

  dispose(): Promise<void> {
    for (const e of this.entries.values()) this.cancelScript(e);
    this.handlers.clear();
    return Promise.resolve();
  }

  /** The last `lines` terminal lines (capabilities advertise `terminalRead`). */
  readTerminal(sessionId: string, lines = 200): Promise<string> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.lost) {
      return Promise.reject(new MimirError("not_found", `unknown session ${sessionId}`));
    }
    const tail = entry.terminal.slice(-lines);
    return Promise.resolve(tail.length > 0 ? `${tail.join("\n")}\n` : "");
  }

  /** Marks a session lost and emits `session.lost`. */
  loseSession(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new MimirError("not_found", `unknown session ${sessionId}`);
    this.cancelScript(entry);
    entry.lost = true;
    this.emit({ kind: "session.lost", sessionId, reason: "lost", observedAt: this.iso() });
  }

  chaos(options: ChaosOptions): void {
    if (options.dropNextEvents !== undefined) this.dropRemaining = options.dropNextEvents;
    if (options.emitGap)
      this.emit({ kind: "runtime.gap", reason: "events_lost", observedAt: this.iso() });
  }

  private liveEntries(): Entry[] {
    return [...this.entries.values()].filter((e) => !e.lost);
  }

  private cancelScript(entry: Entry): void {
    for (const cancel of entry.cancels) cancel();
    entry.cancels = [];
  }

  private runStep(entry: Entry, step: ScriptStep): void {
    if (entry.lost) return;
    const sessionId = entry.session.sessionId;
    if (step.state) this.setState(entry, step.state);
    if (step.output !== undefined) {
      entry.terminal.push(step.output);
      this.emit({ kind: "session.output", sessionId, text: step.output, observedAt: this.iso() });
    }
    if (step.exit !== undefined) {
      this.emit({ kind: "session.exited", sessionId, exitCode: step.exit, observedAt: this.iso() });
    }
  }

  private setState(entry: Entry, state: RuntimeSessionState): void {
    entry.session = { ...entry.session, state, lastObservedAt: this.iso() };
    entry.eventSeq += 1;
    this.emit({
      kind: "session.state_changed",
      sessionId: entry.session.sessionId,
      state,
      observedAt: this.iso(),
      sourceEventId: String(entry.eventSeq),
    });
  }

  private emit(event: RuntimeEvent): void {
    if (this.dropRemaining > 0) {
      this.dropRemaining -= 1;
      return;
    }
    for (const h of [...this.handlers]) h(event);
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
