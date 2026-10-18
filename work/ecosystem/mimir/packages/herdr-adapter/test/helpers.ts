import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newId, type RuntimeEvent, type RuntimeSessionSpec } from "@mimir/protocol";
import { HerdrAdapter, MemoryBindingStore, type HerdrTiming } from "../src/index.js";
import { FakeHerdr, type FakeHerdrOptions } from "./fake-herdr.js";

export const FAST_TIMING: Partial<HerdrTiming> = {
  requestTimeoutMs: 2_000,
  connectTimeoutMs: 500,
  shellReadyAttempts: 50,
  shellReadyIntervalMs: 10,
  shellStableMs: 60,
  agentBusyRetries: 10,
  agentBusyRetryMs: 15,
  agentStartTimeoutMs: 5_000,
  readyTimeoutMs: 2_000,
  stopPollAttempts: 10,
  stopPollIntervalMs: 20,
  resubscribeDelayMs: 20,
  resubscribeMaxDelayMs: 100,
  shellCompletionPollMs: 10,
};

export interface Harness {
  fake: FakeHerdr;
  adapter: HerdrAdapter;
  bindings: MemoryBindingStore;
  cleanup(): Promise<void>;
}

const open: Harness[] = [];

export async function setup(
  opts: FakeHerdrOptions = {},
  timing: Partial<HerdrTiming> = {},
): Promise<Harness> {
  const fake = new FakeHerdr(opts);
  await fake.start();
  const bindings = new MemoryBindingStore();
  const adapter = new HerdrAdapter({
    socketPath: fake.socketPath,
    bindings,
    timing: { ...FAST_TIMING, ...timing },
  });
  const h: Harness = {
    fake,
    adapter,
    bindings,
    async cleanup() {
      await adapter.dispose();
      await fake.stop();
    },
  };
  open.push(h);
  return h;
}

export async function cleanupAll(): Promise<void> {
  await Promise.all(open.splice(0).map((h) => h.cleanup()));
}

export function spec(over: Partial<RuntimeSessionSpec> = {}): RuntimeSessionSpec {
  const sessionId = over.sessionId ?? newId("ses");
  return {
    sessionId,
    idempotencyKey: `idem-${sessionId}`,
    crewId: newId("crw"),
    taskId: newId("tsk"),
    agentKind: "shell",
    argv: ["true"],
    cwd: "/tmp",
    env: {},
    workspaceLabel: "mimir-test",
    ...over,
  };
}

export class Collector {
  readonly events: RuntimeEvent[] = [];
  readonly handler = (e: RuntimeEvent) => {
    this.events.push(e);
  };

  states(sessionId: string): string[] {
    return this.events
      .filter((e) => e.kind === "session.state_changed" && e.sessionId === sessionId)
      .map((e) => (e.kind === "session.state_changed" ? e.state : ""));
  }

  async waitFor(pred: (e: RuntimeEvent) => boolean, timeoutMs = 3_000): Promise<RuntimeEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for event; saw ${JSON.stringify(this.events, null, 1)}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export async function until(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

export interface FixtureRecord {
  t_ms: number;
  kind: string;
  sub?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  msg?: { event?: string; data?: Record<string, unknown>; id?: string; result?: unknown };
}

/** Loads a spike recording; each line is `{t_ms, kind, sub, msg:{event,data}}` (or a request/response record). */
export function loadFixture(name: string): FixtureRecord[] {
  return fs
    .readFileSync(path.join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FixtureRecord);
}

/** The pushed HerdR envelopes in a recording, unwrapped from `msg`. */
export function fixtureEnvelopes(name: string): { event: string; data: Record<string, unknown> }[] {
  return loadFixture(name)
    .filter((r) => r.kind === "event" && r.msg?.event)
    .map((r) => ({ event: r.msg!.event!, data: r.msg!.data ?? {} }));
}
