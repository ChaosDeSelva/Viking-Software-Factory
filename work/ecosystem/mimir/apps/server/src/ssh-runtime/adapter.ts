import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  MimirError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";
import {
  sshArguments,
  sshRequest,
  type SshRoute,
  type RemoteRequest,
  type TransportResult,
} from "./transport.js";
import { INTERACTIVE_HARNESSES } from "../terminal-runtime/adapter.js";
import { snapshot, digest, applyResult } from "./workspace.js";

type Binding = {
  session: RuntimeSession;
  jobId: string;
  fingerprint: string;
  baseline: string;
  outputLength: number;
  delivered: boolean;
  cwd: string;
};
type Requester = (route: SshRoute, request: RemoteRequest) => Promise<TransportResult>;
export class SshRuntime implements RuntimeAdapter {
  private readonly bindings = new Map<string, Binding>();
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private polling = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly route: SshRoute,
    private readonly stateFile: string,
    private readonly request: Requester = sshRequest,
  ) {
    sshArguments(route);
    if (existsSync(stateFile)) {
      const stored = JSON.parse(readFileSync(stateFile, "utf8")) as {
        route: SshRoute;
        bindings: Binding[];
      };
      if (JSON.stringify(stored.route) !== JSON.stringify(route))
        throw new Error("SSH route changed with existing sessions; use a separate state file");
      for (const entry of stored.bindings) this.bindings.set(entry.session.sessionId, entry);
    }
  }
  private save() {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ route: this.route, bindings: [...this.bindings.values()] }),
      { mode: 0o600 },
    );
    renameSync(temp, this.stateFile);
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      runtime: "ssh",
      version: "1",
      agentKinds: this.route.backend
        ? INTERACTIVE_HARNESSES
        : ["codex", "claude", "opencode", "gemini", "pi"],
      features: {
        createSession: true,
        sendInput: !!this.route.backend,
        sendKeys: !!this.route.backend,
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
    const r = await this.request(this.route, {
      operation: "health",
      payload: { backend: this.route.backend ?? "cli" },
    });
    return r.state === "confirmed" && r.response.ok === true
      ? { ok: true }
      : { ok: false, detail: "Remote worker unavailable or incompatible" };
  }
  async createSession(spec: RuntimeSessionSpec) {
    if (
      !(
        this.route.backend ? INTERACTIVE_HARNESSES : ["codex", "claude", "opencode", "gemini", "pi"]
      ).includes(spec.agentKind)
    )
      throw new MimirError(
        "capability_unavailable",
        "SSH worker requires a supported headless harness",
      );
    if (Object.keys(spec.env).some((key) => !["MIMIR_TASK_ID", "MIMIR_MISSION_ID"].includes(key)))
      throw new MimirError(
        "validation_failed",
        "SSH workers use host-local credentials; arbitrary environment forwarding is disabled",
      );
    const fingerprint = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    const jobId = createHash("sha256").update(spec.idempotencyKey).digest("hex");
    const prior = [...this.bindings.values()].find((b) => b.jobId === jobId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new MimirError(
          "idempotency_replay_mismatch",
          "Remote launch differs from its original request",
        );
      return { ...prior.session };
    }
    if (this.bindings.has(spec.sessionId))
      throw new MimirError("conflict", "Remote session identity already exists");
    const files = snapshot(spec.cwd);
    const entry: Binding = {
      session: {
        sessionId: spec.sessionId,
        state: "starting",
        runtimeRef: { workspaceId: this.route.host, agentSessionId: jobId },
        agentKind: spec.agentKind,
        cwd: spec.cwd,
        lastObservedAt: new Date().toISOString(),
      },
      jobId,
      fingerprint,
      baseline: digest(files),
      outputLength: 0,
      delivered: false,
      cwd: spec.cwd,
    };
    this.bindings.set(spec.sessionId, entry);
    this.save();
    const result = await this.request(this.route, {
      operation: "submit",
      jobId,
      payload: {
        backend: this.route.backend ?? "cli",
        agentKind: spec.agentKind,
        argv: spec.argv,
        taskEnv: spec.env,
        timeoutMs: spec.timeoutMs ?? 1200000,
        files,
      },
    });
    if (result.state === "confirmed" && result.response.ok === false) {
      this.change(entry, "failed", String(result.response.error ?? "remote_rejected"));
      entry.delivered = true;
      this.save();
    } else if (result.state !== "confirmed") this.change(entry, "unknown", result.reason);
    return { ...entry.session };
  }
  private emit(event: RuntimeEvent) {
    for (const handler of this.listeners) handler(event);
  }
  private change(entry: Binding, state: RuntimeSession["state"], reason?: string) {
    entry.session.state = state;
    entry.session.lastObservedAt = new Date().toISOString();
    this.save();
    this.emit({
      kind: "session.state_changed",
      sessionId: entry.session.sessionId,
      state,
      observedAt: entry.session.lastObservedAt,
      ...(reason ? { runtimeStatus: reason } : {}),
    });
  }
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const entry of this.bindings.values()) {
        if (entry.delivered) continue;
        let result: TransportResult;
        try {
          result = await this.request(this.route, { operation: "inspect", jobId: entry.jobId });
        } catch {
          this.change(entry, "unknown", "remote_request_failed");
          continue;
        }
        if (result.state !== "confirmed" || result.response.ok !== true) {
          this.change(entry, "unknown", "remote_completion_unconfirmed");
          continue;
        }
        const job = result.response.job as
          { state?: string; exitCode?: number; patch?: string; reason?: string } | undefined;
        if (
          !job ||
          ![
            "starting",
            "running",
            "waiting",
            "stopping",
            "blocked",
            "completed",
            "failed",
            "stopped",
            "unknown",
          ].includes(job.state ?? "")
        ) {
          this.change(entry, "unknown", "invalid_remote_state");
          continue;
        }
        const output = typeof result.response.output === "string" ? result.response.output : "";
        if (output.length > entry.outputLength) {
          this.emit({
            kind: "session.output",
            sessionId: entry.session.sessionId,
            text: output.slice(entry.outputLength),
            observedAt: new Date().toISOString(),
          });
          entry.outputLength = output.length;
        }
        if (["completed", "failed", "stopped"].includes(job.state!)) {
          if (job.state === "completed") {
            try {
              if (typeof job.patch !== "string") throw new Error("Missing patch evidence");
              applyResult(entry.cwd, entry.baseline, job.patch);
            } catch {
              this.change(entry, "blocked", "remote_patch_requires_manual_reconciliation");
              continue;
            }
          }
          entry.delivered = true;
          this.save();
          this.emit({
            kind: "session.exited",
            sessionId: entry.session.sessionId,
            exitCode: job.state === "completed" ? 0 : job.exitCode || 1,
            observedAt: new Date().toISOString(),
          });
        }
        this.change(entry, job.state as RuntimeSession["state"], job.reason);
      }
    } finally {
      this.polling = false;
    }
  }
  async listSessions() {
    return [...this.bindings.values()].map((b) => ({ ...b.session }));
  }
  async getSession(id: string) {
    return this.bindings.has(id) ? { ...this.bindings.get(id)!.session } : null;
  }
  async readTerminal(id: string, lines = 200) {
    const entry = this.bindings.get(id);
    if (!entry) throw new MimirError("not_found", "Remote session not found");
    const result = await this.request(this.route, { operation: "inspect", jobId: entry.jobId });
    if (result.state !== "confirmed" || typeof result.response.output !== "string")
      throw new MimirError("capability_unavailable", "Remote output unavailable");
    return result.response.output
      .split("\n")
      .slice(-Math.min(5000, Math.max(1, lines)))
      .join("\n");
  }
  private async interactiveControl(
    id: string,
    operation: "input" | "keys",
    payload: Record<string, unknown>,
  ) {
    if (!this.route.backend)
      throw new MimirError(
        "capability_unavailable",
        "Remote headless tasks do not accept interactive input",
      );
    const entry = this.bindings.get(id);
    if (!entry) throw new MimirError("not_found", "Remote session not found");
    if (entry.delivered) throw new MimirError("conflict", "Remote session has exited");
    const result = await this.request(this.route, {
      operation,
      jobId: entry.jobId,
      payload: { ...payload, commandId: randomUUID() },
    });
    if (result.state !== "confirmed" || result.response.ok !== true) {
      this.change(entry, "unknown", "remote_input_unconfirmed");
      throw new MimirError(
        "runtime_unavailable",
        "Remote input delivery uncertain; inspect before sending again",
      );
    }
  }
  async sendInput(id: string, input: { text?: string; keys?: string[] }): Promise<void> {
    if (input.text && input.keys?.length)
      throw new MimirError("validation_failed", "Send text or keys in separate commands");
    if (input.text) await this.interactiveControl(id, "input", { text: input.text });
    else if (input.keys?.length) await this.interactiveControl(id, "keys", { keys: input.keys });
    else throw new MimirError("validation_failed", "Input is empty");
  }
  async requestStop(id: string, mode: "soft" | "force") {
    const entry = this.bindings.get(id);
    if (!entry) throw new MimirError("not_found", "Remote session not found");
    if (entry.delivered) return;
    const result = await this.request(this.route, {
      operation: "cancel",
      jobId: entry.jobId,
      payload: { mode },
    });
    this.change(
      entry,
      result.state === "confirmed" && result.response.ok === true ? "stopping" : "unknown",
      "remote_cancel_requested",
    );
  }
  async subscribe(handler: (e: RuntimeEvent) => void) {
    this.listeners.add(handler);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll();
      }, 1000);
      this.timer.unref();
    }
    return {
      close: () => {
        this.listeners.delete(handler);
      },
    };
  }
  async reconcile() {
    await this.poll();
    return { sessions: await this.listSessions(), lost: [] };
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.polling) await new Promise((r) => setTimeout(r, 20));
    this.listeners.clear();
  }
}
