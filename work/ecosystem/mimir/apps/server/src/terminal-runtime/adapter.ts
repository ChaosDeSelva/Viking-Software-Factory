import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";
import { bindTranscript, observeTranscript, type TranscriptBinding } from "./transcripts.js";
import { wireAgy, wireRovo, cleanupPlugin, type ManagedPlugin } from "./vendor-hooks.js";
import { wireHarnessHooks } from "./harness-hooks.js";
import { type HookObservation } from "./hooks.js";
import type { TerminalBackend } from "./backend.js";
export const INTERACTIVE_HARNESSES = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "pi-signed",
  "grok",
  "kimi",
  "cursor",
  "gemini",
  "muse",
  "rovo",
  "omp",
  "agy",
  "devin",
  "commandcode",
];
const binaries: Record<string, string> = {
  "pi-signed": "pi",
  cursor: "cursor-agent",
  rovo: "acli",
};
export function interactiveArgv(kind: string, prompt: string): string[] {
  if (!INTERACTIVE_HARNESSES.includes(kind))
    throw new MimirError("capability_unavailable", "Unknown interactive harness");
  const binary = binaries[kind] ?? kind;
  // No unattended approval-bypass flags. Harness permissions remain visible to the operator.
  if (kind === "rovo") return [binary, "rovodev", "run", prompt];
  if (kind === "gemini" || kind === "agy") return [binary, "--prompt-interactive", prompt];
  if (kind === "kimi") return [binary, "acp"];
  if (kind === "grok") return [binary, "--no-auto-update", "agent", "stdio"];
  if (kind === "opencode") return [binary, "--prompt", prompt];
  return [binary, prompt];
}
type Binding = {
  session: RuntimeSession;
  key: string;
  fingerprint: string;
  label: string;
  target?: string;
  result: string;
  delivered: boolean;
  output: string;
  stopping: boolean;
  hookFile?: string;
  lastHookId?: string;
  inputAfter?: number;
  transcript?: TranscriptBinding;
  managedPlugin?: ManagedPlugin;
};
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export class TerminalRuntime implements RuntimeAdapter {
  private bindings = new Map<string, Binding>();
  private handlers = new Set<(e: RuntimeEvent) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly backend: TerminalBackend,
    private readonly home: string,
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (existsSync(join(home, "sessions.json"))) {
      const stored = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
      if (stored.backend !== backend.name) throw new Error("Terminal backend identity changed");
      this.bindings = new Map(stored.bindings);
    }
  }
  private save() {
    const file = join(this.home, "sessions.json"),
      temp = file + "." + randomUUID();
    writeFileSync(
      temp,
      JSON.stringify({ backend: this.backend.name, bindings: [...this.bindings] }),
      { mode: 0o600 },
    );
    renameSync(temp, file);
  }
  private emit(e: RuntimeEvent) {
    for (const h of this.handlers) h(e);
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      runtime: this.backend.name,
      version: "1",
      agentKinds: INTERACTIVE_HARNESSES,
      features: {
        createSession: true,
        sendInput: true,
        sendKeys: true,
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
    return { ok: await this.backend.health() };
  }
  createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    const result = this.queue.then(() => this.create(spec));
    this.queue = result.catch(() => {});
    return result;
  }
  private async create(spec: RuntimeSessionSpec) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ...spec,
          env: Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))),
        }),
      )
      .digest("hex");
    const prior = [...this.bindings.values()].find((b) => b.key === spec.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new MimirError("idempotency_replay_mismatch", "Terminal request changed");
      return { ...prior.session };
    }
    if (this.bindings.has(spec.sessionId))
      throw new MimirError("conflict", "Session already exists");
    const prompt = spec.argv.at(-1) ?? "";
    const argv = interactiveArgv(spec.agentKind, prompt);
    if (!(await this.backend.health()))
      throw new MimirError("runtime_unavailable", "Terminal backend is unavailable");
    const executable =
      process.env[`MIMIR_${spec.agentKind.toUpperCase().replaceAll("-", "_")}_BIN`] ?? argv[0]!;
    const label = "mimir-" + createHash("sha256").update(spec.sessionId).digest("hex").slice(0, 24);
    const resultFile = join(this.home, label + ".result.json");
    const hookFile = join(this.home, label + ".hook.json");
    const hook = fileURLToPath(
      new URL(
        existsSync(new URL("./hook-command.js", import.meta.url))
          ? "./hook-command.js"
          : "../../dist/terminal-runtime/hook-command.js",
        import.meta.url,
      ),
    );
    const hookEnv = wireHarnessHooks(spec.agentKind, argv, process.execPath, hook, hookFile);
    const vendorHelper = join(hook.slice(0, hook.lastIndexOf("/")), "vendor-hook-command.js");
    if (spec.agentKind === "rovo") wireRovo(argv, process.execPath, vendorHelper, hookFile);
    const managedPlugin =
      spec.agentKind === "agy"
        ? wireAgy(spec.cwd, process.execPath, vendorHelper, hookFile)
        : undefined;
    const transcript = bindTranscript(spec.agentKind, spec.cwd, {
      ...process.env,
      ...spec.env,
    } as Record<string, string>);
    const entry: Binding = {
      ...(transcript ? { transcript } : {}),
      ...(managedPlugin ? { managedPlugin } : {}),
      key: spec.idempotencyKey,
      fingerprint,
      label,
      result: resultFile,
      hookFile,
      delivered: false,
      output: "",
      stopping: false,
      session: {
        sessionId: spec.sessionId,
        state: "starting",
        agentKind: spec.agentKind,
        cwd: spec.cwd,
        runtimeRef: {},
        lastObservedAt: new Date().toISOString(),
      },
    };
    const configFile = join(this.home, label + ".launch.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        executable,
        agentKind: spec.agentKind,
        prompt,
        args: argv.slice(1),
        cwd: spec.cwd,
        env: { ...spec.env, ...hookEnv, MIMIR_HOOK_FILE: hookFile },
        timeoutMs: spec.timeoutMs ?? 1200000,
        resultFile,
      }),
      { mode: 0o600 },
    );
    this.bindings.set(spec.sessionId, entry);
    this.save();
    try {
      entry.target = await this.backend.create(label, spec.cwd);
      entry.session.runtimeRef = { terminalId: entry.target };
      this.save();
      const runner = fileURLToPath(
        new URL(
          existsSync(new URL("./runner.js", import.meta.url))
            ? "./runner.js"
            : "../../dist/terminal-runtime/runner.js",
          import.meta.url,
        ),
      );
      await this.backend.send(
        entry.target,
        `exec ${quote(process.execPath)} ${quote(runner)} ${quote(configFile)}`,
        label,
      );
      entry.session.state = "running";
    } catch {
      entry.session.state = "unknown";
    }
    this.save();
    return { ...entry.session };
  }
  private entry(id: string) {
    const b = this.bindings.get(id);
    if (!b) throw new MimirError("not_found", "Terminal session not found");
    return b;
  }
  async listSessions() {
    return [...this.bindings.values()].map((b) => ({ ...b.session }));
  }
  async getSession(id: string) {
    return this.bindings.has(id) ? { ...this.entry(id).session } : null;
  }
  async sendInput(id: string, input: { text?: string; keys?: string[] }) {
    const b = this.entry(id);
    if (!b.target || b.delivered || b.stopping || b.session.state === "unknown")
      throw new MimirError("capability_unavailable", "Session is not available for input");
    if (input.text !== undefined) {
      if (
        Buffer.byteLength(input.text) > 65536 ||
        Array.from(input.text).some((c) => {
          const n = c.charCodeAt(0);
          return n < 9 || (n > 10 && n < 32) || n === 127;
        })
      )
        throw new MimirError("validation_failed", "Unsupported terminal input");
    }
    const keys = input.keys ?? [];
    if (
      keys.some(
        (key) => !["Enter", "Escape", "C-c", "C-d", "C-z", "Up", "Down", "Tab"].includes(key),
      )
    )
      throw new MimirError("validation_failed", "Unsupported terminal key");
    if (input.text === undefined && keys.length === 0) return;
    // Persist before dispatch: a timeout may mean the input reached the agent.
    // Old idle/permission observations must not survive that ambiguity or restart.
    if (b.transcript) {
      const prior = observeTranscript(b.transcript);
      if (prior) b.transcript.ignored = prior.fingerprint;
    }
    b.inputAfter = Date.now();
    delete b.lastHookId;
    if (b.hookFile) {
      try {
        const prior = JSON.parse(readFileSync(b.hookFile, "utf8"));
        if (typeof prior.id === "string") b.lastHookId = prior.id;
      } catch {
        // Missing or partial hook evidence cannot establish an idle session.
      }
    }
    b.session.state = "running";
    this.save();
    try {
      if (input.text !== undefined) {
        const acp = ["kimi", "grok"].includes(b.session.agentKind ?? "");
        const text =
          acp && !/^\/(?:cancel|quit)$|^\/permit [^\n\r]+$/.test(input.text)
            ? "/prompt " + JSON.stringify(input.text)
            : input.text;
        await this.backend.send(b.target, text, b.label);
      }
      for (const key of keys) await this.backend.key(b.target, key, b.label);
    } catch (error) {
      b.session.state = "unknown";
      this.save();
      throw error;
    }
  }

  async requestStop(id: string, mode: "soft" | "force") {
    const b = this.entry(id);
    if (b.delivered) return;
    if (!b.target) throw new MimirError("capability_unavailable", "Terminal target is unknown");
    b.stopping = true;
    this.save();
    if (mode === "soft") await this.backend.key(b.target, "C-c", b.label);
    else await this.backend.close(b.target, b.label);
    // A backend acknowledging close does not prove the child stopped.
    // In particular, some upstream close helpers deliberately return success when unavailable.
    b.session.state = mode === "force" ? "unknown" : "stopping";
    this.save();
    this.emit({
      kind: "session.state_changed",
      sessionId: id,
      state: b.session.state,
      observedAt: new Date().toISOString(),
    });
  }
  async readTerminal(id: string, lines = 200) {
    const b = this.entry(id);
    if (!b.target) throw new MimirError("capability_unavailable", "Terminal target unknown");
    return this.backend.capture(b.target, Math.min(5000, Math.max(1, lines)), b.label);
  }
  private poll() {
    return (this.polling ??= this.observe().finally(() => {
      this.polling = undefined;
    }));
  }
  private async observe() {
    for (const b of this.bindings.values()) {
      if (b.delivered) continue;
      let state: RuntimeSession["state"] = "unknown";
      let exitCode: number | undefined;
      if (existsSync(b.result)) {
        try {
          const r = JSON.parse(readFileSync(b.result, "utf8"));
          if (["completed", "failed"].includes(r.state) && Number.isInteger(r.exitCode)) {
            state = b.stopping ? "stopped" : r.state;
            exitCode = r.exitCode;
          } else if (r.state === "running" && Date.now() - Date.parse(r.observedAt) < 10000)
            state = b.stopping ? "stopping" : "running";
        } catch {
          /* Partial observations do not imply termination. */
        }
      }
      if (b.target) {
        try {
          const output = await this.backend.capture(b.target, 200, b.label);
          if (output !== b.output) {
            b.output = output;
            this.emit({
              kind: "session.output",
              sessionId: b.session.sessionId,
              text: output,
              observedAt: new Date().toISOString(),
            });
          }
        } catch {
          if (exitCode === undefined) state = "unknown";
        }
      }
      const transcript =
        state === "running" && b.transcript ? observeTranscript(b.transcript) : undefined;
      if (transcript) state = transcript.state;
      let hook: HookObservation | undefined;
      if (state === "running" && b.hookFile && existsSync(b.hookFile)) {
        try {
          const observation = JSON.parse(readFileSync(b.hookFile, "utf8")) as HookObservation;
          if (
            ["running", "waiting", "blocked"].includes(observation.state) &&
            typeof observation.id === "string" &&
            observation.id !== b.lastHookId &&
            Number.isFinite(Date.parse(observation.observedAt)) &&
            Date.parse(observation.observedAt) >= (b.inputAfter ?? 0) &&
            Date.parse(observation.observedAt) <= Date.now() + 5000 &&
            [
              "harness_permission_request",
              "harness_awaiting_input",
              "harness_quota_wait",
              "harness_error",
              "harness_working",
            ].includes(observation.reason)
          ) {
            hook = observation;
            state = observation.state;
          }
        } catch {
          /* Malformed hooks cannot certify task completion. */
        }
      }
      b.session.state = state;
      b.session.lastObservedAt = new Date().toISOString();
      if (exitCode !== undefined) {
        if (b.managedPlugin) {
          cleanupPlugin(b.managedPlugin);
          delete b.managedPlugin;
        }
        b.delivered = true;
        this.emit({
          kind: "session.exited",
          sessionId: b.session.sessionId,
          exitCode,
          observedAt: b.session.lastObservedAt,
        });
      }
      this.emit({
        kind: "session.state_changed",
        sessionId: b.session.sessionId,
        state,
        ...(hook
          ? { runtimeStatus: hook.reason, sourceEventId: hook.id }
          : transcript
            ? {
                runtimeStatus: `${b.transcript?.kind}_session_transcript`,
                sourceEventId: transcript.fingerprint,
              }
            : {}),
        observedAt: b.session.lastObservedAt,
      });
      this.save();
    }
  }
  async subscribe(handler: (e: RuntimeEvent) => void) {
    this.handlers.add(handler);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll().catch(() => {});
      }, 1000);
      this.timer.unref();
    }
    return {
      close: () => {
        this.handlers.delete(handler);
      },
    };
  }
  async reconcile() {
    await this.poll();
    return { sessions: await this.listSessions(), lost: [] };
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    await this.queue;
    await this.polling;
    this.handlers.clear();
  }
}
