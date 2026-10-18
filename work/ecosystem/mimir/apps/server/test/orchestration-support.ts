import type { FakeRuntime } from "@mimir/fake-runtime";
import type {
  EventEnvelope,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionSpec,
} from "@mimir/protocol";
import {
  harness as baseHarness,
  type Harness,
  type HarnessOptions,
} from "../src/orchestrator/test-harness.js";

export {
  createTask,
  setupMission,
  T0,
  type Harness,
  type Json,
} from "../src/orchestrator/test-harness.js";

// TODO(T12fix): remove once ProjectSettings.allowedCommands is wired into classifyCommand.
// Interim (ruling on the T11fix4 post-merge repair): exact-allowlist classifies `sh -c "echo ..."`
// shell crews as shell.unclassified; admit that class only. Specific actions (shell.destructive
// for `rm -rf`, git.push, ...) are still gated by the default policy.
export const ADMIT_UNCLASSIFIED = {
  id: "test#admit-unclassified",
  action: "shell.unclassified" as const,
  effect: "allow" as const,
};

/** The orchestrator test harness with the interim `shell.unclassified` admission. */
export const harness = (opts: HarnessOptions = {}): Promise<Harness> =>
  baseHarness({ ...opts, policies: [ADMIT_UNCLASSIFIED, ...(opts.policies ?? [])] });

/** Polls (real time) until `cond` holds; git under load can take seconds per worktree. */
export async function waitFor(cond: () => boolean, ms = 25_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

/**
 * Delegates to the fake runtime and records every call that reaches the runtime, so a test can
 * prove a command never got there (`createSession` in particular).
 */
export class RecordingRuntime implements RuntimeAdapter {
  readonly created: RuntimeSessionSpec[] = [];
  readonly inputs: { sessionId: string; input: { text?: string; keys?: string[] } }[] = [];
  readonly stops: { sessionId: string; mode: "soft" | "force" }[] = [];
  handlers: ((e: RuntimeEvent) => void)[] = [];

  constructor(readonly fake: FakeRuntime) {}
  capabilities = () => this.fake.capabilities();
  health = () => this.fake.health();
  listSessions = () => this.fake.listSessions();
  getSession = (id: string) => this.fake.getSession(id);
  reconcile = () => this.fake.reconcile();
  dispose = () => this.fake.dispose();
  sendInput(sessionId: string, input: { text?: string; keys?: string[] }): Promise<void> {
    this.inputs.push({ sessionId, input });
    return this.fake.sendInput(sessionId, input);
  }
  requestStop(sessionId: string, mode: "soft" | "force"): Promise<void> {
    this.stops.push({ sessionId, mode });
    return this.fake.requestStop(sessionId, mode);
  }
  createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    this.created.push(spec);
    return this.fake.createSession(spec);
  }
  async subscribe(handler: (e: RuntimeEvent) => void): Promise<{ close(): void }> {
    this.handlers.push(handler);
    const sub = await this.fake.subscribe(handler);
    return {
      close: () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
        sub.close();
      },
    };
  }
  /** Pushes an event as if the runtime observed it. */
  emit(e: RuntimeEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

/** Event types for one task, in log order. */
export const typesFor = (h: Harness, taskId: string): string[] =>
  h
    .events()
    .filter((e) => e.taskId === taskId)
    .map((e) => e.type);

/** No event id twice, and every stream's sequences run 1..n without holes. */
export function expectConsistentLog(events: readonly EventEnvelope[]): string[] {
  const problems: string[] = [];
  if (new Set(events.map((e) => e.id)).size !== events.length) problems.push("duplicate ids");
  const byStream = new Map<string, number[]>();
  for (const e of events)
    byStream.set(e.streamId, [...(byStream.get(e.streamId) ?? []), e.sequence]);
  for (const [stream, seqs] of byStream) {
    if (seqs.some((s, i) => s !== i + 1)) problems.push(`stream ${stream}: ${seqs.join(",")}`);
  }
  return problems;
}
