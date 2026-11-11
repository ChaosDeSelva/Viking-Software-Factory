import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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

type Usage = { tokens: number; estimatedCost: number | null; cachedTokens: number };
type RawUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
};
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

/**
 * Budget usage of one agent JSONL event, or null for an event that does not report it.
 *
 * - Codex `exec --json` `turn.completed`: `usage` is the thread's running total
 *   (`total_token_usage`), not the turn's delta, so the last one is the session's total and the
 *   caller keeps only the last (summing them would count earlier turns again). `input_tokens`
 *   sums the input of every model request in the turn and INCLUDES `cached_input_tokens`; each
 *   request re-sends the context, so ~90% of it is cache hits (live: 259,194 input of which
 *   235,520 cached). `output_tokens` already includes `reasoning_output_tokens`.
 *   Counted: (input - cached) + output, Codex's own "blended total". Cached: cached_input_tokens.
 * - Claude `stream-json` `result`: totals for the whole run. `input_tokens` EXCLUDES the cache:
 *   `cache_creation_input_tokens` is fresh input written to the cache (counted, it is real new
 *   context), `cache_read_input_tokens` is re-read context (not counted, reported as cached).
 *   Counted: input + cache_creation + output. Cached: cache_read.
 */
export function usageOfEvent(line: string): Usage | null {
  let e: { type?: unknown; usage?: RawUsage; total_cost_usd?: unknown };
  try {
    e = JSON.parse(line) as typeof e;
  } catch {
    return null; // terminal output is not necessarily a JSON event
  }
  if (e === null || typeof e !== "object" || !e.usage || typeof e.usage !== "object") return null;
  const u = e.usage;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (input === null || output === null) return null;
  let tokens: number;
  let cachedTokens: number;
  if (e.type === "turn.completed") {
    cachedTokens = Math.min(count(u.cached_input_tokens) ?? 0, input);
    tokens = input - cachedTokens + output;
  } else if (e.type === "result") {
    cachedTokens = count(u.cache_read_input_tokens) ?? 0;
    tokens = input + (count(u.cache_creation_input_tokens) ?? 0) + output;
  } else return null;
  const cost = e.total_cost_usd;
  return {
    tokens,
    cachedTokens,
    estimatedCost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}
/** Finished sessions kept readable (each holds up to 2 MiB of terminal text); older ones are forgotten. */
export const FINISHED_SESSIONS_KEPT = 50;
/** Idempotency keys of forgotten sessions, kept so a replay is refused instead of relaunched. */
export const FORGOTTEN_LAUNCHES_KEPT = 1000;
type Entry = {
  session: RuntimeSession;
  key: string;
  worker: ChildProcess;
  done: Promise<void>;
  stopped: boolean;
  failure?: string;
  pending: string;
  terminal: string;
  usage?: Usage;
};

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Local non-interactive CLIs, supervised through an IPC watchdog. */
export class CliRuntime implements RuntimeAdapter {
  private readonly sessions = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  /** Request fingerprint hash by idempotency key of evicted sessions, oldest first. */
  private readonly forgotten = new Map<string, string>();
  /** Sessions whose watchdog has ended, oldest first. */
  private readonly finished = new Set<string>();
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
    const forgotten = this.forgotten.get(spec.idempotencyKey);
    if (forgotten !== undefined) {
      if (forgotten !== digest(fingerprint))
        throw new MimirError(
          "idempotency_replay_mismatch",
          "Session launch differs from the original request",
        );
      throw new MimirError(
        "conflict",
        "Session launch already finished and is no longer in runtime memory",
      );
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
    let resolveDone!: () => void;
    let finished = false;
    // `error` and `exit` may both arrive; a second retire would re-add an evicted session.
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveDone();
      this.retire(spec.sessionId);
    };
    const entry: Entry = {
      session: {
        sessionId: spec.sessionId,
        runtimeRef: {},
        state: "running",
        agentKind: spec.agentKind,
        cwd: spec.cwd,
        lastObservedAt: new Date().toISOString(),
      },
      key: spec.idempotencyKey,
      worker,
      stopped: false,
      pending: "",
      terminal: "",
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
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
    // `exit` may never follow `error` (spawn failure): end the session here, and close a watchdog
    // that is still connected so it kills its agent rather than leaving it unsupervised.
    worker.on("error", () => {
      entry.failure = "worker_unavailable";
      if (entry.session.state === "running") {
        entry.session.state = "failed";
        this.emit({
          kind: "session.state_changed",
          sessionId: spec.sessionId,
          state: "failed",
          runtimeStatus: entry.failure,
          observedAt: new Date().toISOString(),
        });
      }
      if (worker.connected) worker.disconnect();
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
        ...spec.agentEnv?.env,
        ...(spec.agentEnv?.pathPrepend?.length
          ? {
              PATH: [
                ...spec.agentEnv.pathPrepend,
                ...(process.env["PATH"] ? [process.env["PATH"]] : []),
              ].join(":"),
            }
          : {}),
        ...spec.env,
      },
      timeoutMs: spec.timeoutMs,
    });
    return entry.session;
  }
  private retire(id: string) {
    this.finished.add(id);
    for (const old of this.finished) {
      if (this.finished.size <= FINISHED_SESSIONS_KEPT) break;
      const entry = this.sessions.get(old);
      this.sessions.delete(old);
      if (entry) {
        this.forgotten.set(entry.key, digest(this.requests.get(entry.key) ?? ""));
        for (const key of this.forgotten.keys()) {
          if (this.forgotten.size <= FORGOTTEN_LAUNCHES_KEPT) break;
          this.forgotten.delete(key);
        }
        this.keys.delete(entry.key);
        this.requests.delete(entry.key);
      }
      this.finished.delete(old);
    }
  }
  private parseUsage(entry: Entry, line: string) {
    // Both CLIs report running totals: the last event is the session's usage.
    const usage = usageOfEvent(line);
    if (usage) entry.usage = usage;
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
