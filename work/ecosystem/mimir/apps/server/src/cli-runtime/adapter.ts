import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";

type Usage = { tokens: number; estimatedCost: number | null };
type Entry = {
  session: RuntimeSession;
  worker: ChildProcess;
  done: Promise<void>;
  stopped: boolean;
  failure?: string;
  pending: string;
  terminal: string;
  usage?: Usage;
};

/** Local non-interactive CLIs, supervised through an IPC watchdog. */
export class CliRuntime implements RuntimeAdapter {
  private readonly sessions = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(
    private readonly executables: Partial<
      Record<"codex" | "claude" | "opencode" | "gemini" | "pi", string>
    > = {},
    private readonly backend: "cli" | "tmux" = "cli",
  ) {}
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      runtime: this.backend,
      version: "1",
      agentKinds: ["codex", "claude", "opencode", "gemini", "pi"],
      features: {
        createSession: true,
        sendInput: false,
        sendKeys: false,
        softStop: true,
        forceStop: true,
        pause: false,
        subscribe: true,
        terminalRead: true,
        processInfo: false,
        multiHost: false,
        notify: false,
      },
    };
  }
  async health() {
    return { ok: true };
  }
  async createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    const known = this.keys.get(spec.idempotencyKey);
    const fingerprint = JSON.stringify({
      ...spec,
      env: Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))),
    });
    if (known) {
      if (this.requests.get(spec.idempotencyKey) !== fingerprint)
        throw new MimirError(
          "idempotency_replay_mismatch",
          "Session launch differs from the original request",
        );
      return this.sessions.get(known)!.session;
    }
    if (this.sessions.has(spec.sessionId))
      throw new MimirError("conflict", "Session ID already belongs to another launch");
    if (!["codex", "claude", "opencode", "gemini", "pi"].includes(spec.agentKind))
      throw new MimirError("capability_unavailable", "No headless CLI profile for this agent kind");
    const bundled =
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    let executable =
      this.executables[spec.agentKind as keyof typeof this.executables] ??
      (spec.agentKind === "codex"
        ? (process.env["MIMIR_CODEX_BIN"] ?? (existsSync(bundled) ? bundled : "codex"))
        : (process.env[`MIMIR_${spec.agentKind.toUpperCase()}_BIN`] ?? spec.agentKind));
    // The orchestrator has already classified argv. Preserve its arguments; only the binary path is resolved locally.
    let args = spec.argv.slice(1);
    if (this.backend === "tmux") {
      args = [
        fileURLToPath(
          new URL(
            existsSync(new URL("./tmux-driver.js", import.meta.url))
              ? "./tmux-driver.js"
              : "./tmux-driver.ts",
            import.meta.url,
          ),
        ),
        executable,
        ...args,
      ];
      executable = process.execPath;
    }
    const worker = fork(
      fileURLToPath(
        new URL(
          existsSync(new URL("./worker.js", import.meta.url)) ? "./worker.js" : "./worker.ts",
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
      },
    );
    let finish!: () => void;
    const entry: Entry = {
      session: {
        sessionId: spec.sessionId,
        runtimeRef: {},
        state: "running",
        agentKind: spec.agentKind,
        cwd: spec.cwd,
        lastObservedAt: new Date().toISOString(),
      },
      worker,
      stopped: false,
      pending: "",
      terminal: "",
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.sessions.set(spec.sessionId, entry);
    this.keys.set(spec.idempotencyKey, spec.sessionId);
    this.requests.set(spec.idempotencyKey, fingerprint);
    worker.on(
      "message",
      (message: { kind: string; text?: string; stderr?: boolean; code?: number }) => {
        const observedAt = new Date().toISOString();
        entry.session.lastObservedAt = observedAt;
        if (message.kind === "output") {
          const text = message.text ?? "";
          entry.terminal = (entry.terminal + text).slice(-2 * 1024 * 1024);
          if (!message.stderr) {
            entry.pending += text;
            const lines = entry.pending.split("\n");
            entry.pending = lines.pop() ?? "";
            for (const line of lines) this.parseUsage(entry, line);
            if (entry.pending.length > 2 * 1024 * 1024) entry.pending = "";
          }
          this.emit({ kind: "session.output", sessionId: spec.sessionId, text, observedAt });
        } else if (
          message.kind === "timeout" ||
          message.kind === "limit" ||
          message.kind === "error"
        ) {
          entry.failure =
            message.kind === "timeout"
              ? "wall_clock_limit"
              : message.kind === "limit"
                ? "output_limit"
                : "cli_unavailable";
        } else if (message.kind === "exit") {
          this.parseUsage(entry, entry.pending);
          this.emit({
            kind: "session.exited",
            sessionId: spec.sessionId,
            exitCode: message.code ?? 1,
            observedAt,
            ...(entry.usage ? { usage: entry.usage } : {}),
          });
          entry.session.state = entry.stopped
            ? "stopped"
            : !entry.failure && message.code === 0
              ? "completed"
              : "failed";
          this.emit({
            kind: "session.state_changed",
            sessionId: spec.sessionId,
            state: entry.session.state,
            observedAt,
            ...(entry.failure ? { runtimeStatus: entry.failure } : {}),
          });
        }
      },
    );
    worker.on("exit", () => {
      if (entry.session.state === "running") {
        entry.session.state = "failed";
        this.emit({
          kind: "session.state_changed",
          sessionId: spec.sessionId,
          state: "failed",
          runtimeStatus: "worker_lost",
          observedAt: new Date().toISOString(),
        });
      }
      finish();
    });
    worker.on("error", () => {
      entry.failure = "worker_unavailable";
      finish();
    });
    worker.send({
      kind: "start",
      executable,
      args,
      cwd: spec.cwd,
      env: {
        ...Object.fromEntries(
          [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SECURITYSESSIONID",
            "__CF_USER_TEXT_ENCODING",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "TERM",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "MIMIR_TMUX_BIN",
          ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        ),
        ...spec.env,
      },
      timeoutMs: spec.timeoutMs,
    });
    return entry.session;
  }
  private parseUsage(entry: Entry, line: string) {
    try {
      const e = JSON.parse(line) as {
        type?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        total_cost_usd?: number;
      };
      if (!e.usage || !["turn.completed", "result"].includes(e.type ?? "")) return;
      const u = e.usage;
      if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return;
      const tokens =
        u.input_tokens +
        u.output_tokens +
        (e.type === "result"
          ? (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
          : 0);
      if (!Number.isFinite(tokens) || tokens < 0) return;
      entry.usage = {
        tokens,
        estimatedCost:
          typeof e.total_cost_usd === "number" &&
          Number.isFinite(e.total_cost_usd) &&
          e.total_cost_usd >= 0
            ? e.total_cost_usd
            : null,
      };
    } catch {
      /* terminal output is not necessarily a JSON event */
    }
  }
  private emit(event: RuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async listSessions() {
    return [...this.sessions.values()].map((e) => ({ ...e.session }));
  }
  async getSession(id: string) {
    return this.sessions.get(id)?.session ?? null;
  }
  async readTerminal(id: string, lines = 200): Promise<string> {
    const entry = this.sessions.get(id);
    if (!entry)
      throw new MimirError(
        "not_found",
        "session output is no longer in runtime memory; inspect persisted session.output events",
      );
    return entry.terminal
      .split("\n")
      .slice(-Math.min(5000, Math.max(1, lines)))
      .join("\n");
  }
  async sendInput(): Promise<void> {
    throw new MimirError(
      "capability_unavailable",
      "Non-interactive tasks accept a new prompt through retry, not terminal input",
    );
  }
  async subscribe(handler: (e: RuntimeEvent) => void) {
    this.listeners.add(handler);
    return {
      close: () => {
        this.listeners.delete(handler);
      },
    };
  }
  async requestStop(id: string, mode: "soft" | "force") {
    const entry = this.sessions.get(id);
    if (!entry) throw new MimirError("not_found", "session not found");
    entry.stopped = true;
    if (entry.worker.connected) entry.worker.send({ kind: "stop", force: mode === "force" });
  }
  async reconcile() {
    return { sessions: await this.listSessions(), lost: [] };
  }
  async dispose() {
    for (const e of this.sessions.values())
      if (e.worker.connected) {
        e.stopped = true;
        e.worker.disconnect();
      }
    await Promise.all([...this.sessions.values()].map((e) => e.done));
    this.listeners.clear();
  }
}
