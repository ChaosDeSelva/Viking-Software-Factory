import { monitorEventLoopDelay } from "node:perf_hooks";
import { FakeRuntime, ManualClock, type ScriptStep } from "@mimir/fake-runtime";
import { newId, type RuntimeEvent, type SessionId } from "@mimir/protocol";
import {
  openBenchSse,
  summarize,
  type BenchResult,
  type BenchSseClient,
  type SseMessage,
} from "@mimir/testing";
import {
  BENCH_AUTH,
  outputEvent,
  r3,
  sleep,
  startServer,
  tempFileStore,
  type Scenario,
} from "../harness.js";

const SESSIONS = 20;
const RATE_PER_SESSION = 10; // events per second
const FULL_DURATION_MS = 30_000;
const UI_CLIENTS = 2;
const RECONNECT_PAUSE_MS = 500;

/**
 * Scenario 1: 20 concurrent FakeRuntime sessions each emitting 10 structured events per second
 * for 30 s into a file-backed store, with fleet-UI SSE clients connected to the real server.
 * Measures store append latency, append -> SSE receipt latency and event-loop delay.
 */
export const sustained: Scenario = {
  name: "sustained",
  description: "20 sessions x 10 events/s x 30 s, store append + SSE end-to-end latency",
  async run({ scale, log }) {
    const durationMs = Math.max(1000, Math.round(FULL_DURATION_MS * scale));
    const perSession = Math.round((durationMs / 1000) * RATE_PER_SESSION);
    const expected = SESSIONS * perSession;
    const { store, cleanup } = tempFileStore();
    // Real-time driven manual clock: the FakeRuntime emits on wall-clock time. Every session
    // runs the same script (one output every 100 ms); sessions are created 5 ms apart on the
    // clock so their emissions interleave instead of arriving in one burst.
    const clock = new ManualClock(Date.now());
    const script: ScriptStep[] = Array.from({ length: perSession }, (_, k) => ({
      afterMs: Math.round(((k + 1) * 1000) / RATE_PER_SESSION),
      output: `line ${k}`,
    }));
    const runtime = new FakeRuntime({ clock, script });
    const server = await startServer(store, {}, runtime);

    const appendMs: number[] = [];
    const sentAt = new Map<string, number>();
    const e2eMs: number[] = [];
    const clients: BenchSseClient[] = [];
    const streamUrl = `${server.url}/v1/events/stream`;
    const onMessage = (msg: SseMessage, at: number) => {
      if (msg.event !== "session.output" || msg.data === undefined) return;
      const { id } = JSON.parse(msg.data) as { id: string };
      const t0 = sentAt.get(id);
      if (t0 !== undefined) e2eMs.push(at - t0);
    };
    for (let i = 0; i < UI_CLIENTS; i++) {
      clients.push(await openBenchSse(streamUrl, BENCH_AUTH, onMessage));
    }
    // The last UI client disconnects half-way and reconnects with its Last-Event-ID.
    const firstLeg = clients[UI_CLIENTS - 1] as BenchSseClient;
    let secondLeg: BenchSseClient | undefined;

    // Bridge: runtime observation -> durable event (what the orchestrator's ingest does).
    const sub = await runtime.subscribe((e: RuntimeEvent) => {
      if (e.kind !== "session.output") return;
      const t0 = performance.now();
      const event = store.append(outputEvent(e.sessionId as SessionId, appendMs.length));
      appendMs.push(performance.now() - t0);
      sentAt.set(event.id, t0);
    });

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    for (let s = 0; s < SESSIONS; s++) {
      await runtime.createSession({
        sessionId: newId("ses"),
        idempotencyKey: `bench-${s}`,
        crewId: newId("crw"),
        taskId: newId("tsk"),
        agentKind: "shell",
        argv: [],
        cwd: "/tmp",
        env: {},
        workspaceLabel: `w${s}`,
      });
      clock.advance(Math.floor(1000 / RATE_PER_SESSION / SESSIONS));
    }
    const driver = setInterval(() => clock.advance(Math.max(0, Date.now() - clock.now())), 5);
    const started = performance.now();
    log(`  sustained: ${SESSIONS} sessions, ${expected} events over ${durationMs} ms`);
    try {
      while (appendMs.length < expected && performance.now() - started < durationMs + 10_000) {
        await sleep(100);
        if (secondLeg === undefined && appendMs.length >= expected / 2) {
          firstLeg.close();
          await firstLeg.ended;
          await sleep(RECONNECT_PAUSE_MS);
          const lastId = firstLeg.lastId ?? "";
          // No latency samples from this leg: its replayed backlog waited out the disconnect.
          secondLeg = await openBenchSse(streamUrl, { ...BENCH_AUTH, "last-event-id": lastId });
        }
      }
      const elapsed = performance.now() - started;
      const live = clients.slice(0, UI_CLIENTS - 1);
      await Promise.allSettled([
        ...live.map((c) => c.waitForEvents(expected, 10_000)),
        secondLeg?.waitForEvents(expected - firstLeg.events, 10_000),
      ]);
      const reconnected = firstLeg.events + (secondLeg?.events ?? 0);
      loop.disable();
      const append = summarize(appendMs);
      const e2e = summarize(e2eMs);
      const delivered = Math.min(...live.map((c) => c.events));
      const gaps = [...clients, ...(secondLeg ? [secondLeg] : [])].reduce(
        (n, c) => n + c.gaps + c.errors,
        0,
      );
      const name = "1 sustained";
      const out: BenchResult[] = [
        {
          scenario: name,
          metric: "events appended",
          value: appendMs.length,
          unit: "events",
          threshold: { op: ">=", value: expected, source: "guard" },
        },
        {
          scenario: name,
          metric: "append throughput",
          value: r3(appendMs.length / (elapsed / 1000)),
          unit: "events/s",
        },
        { scenario: name, metric: "store append p50", value: r3(append.p50), unit: "ms" },
        {
          scenario: name,
          metric: "store append p95",
          value: r3(append.p95),
          unit: "ms",
          threshold: { op: "<", value: 25, source: "guard" },
        },
        { scenario: name, metric: "store append p99", value: r3(append.p99), unit: "ms" },
        { scenario: name, metric: "SSE e2e p50", value: r3(e2e.p50), unit: "ms" },
        {
          scenario: name,
          metric: "SSE e2e p95",
          value: r3(e2e.p95),
          unit: "ms",
          threshold: { op: "<", value: 1000, source: "roadmap" },
        },
        { scenario: name, metric: "SSE e2e p99", value: r3(e2e.p99), unit: "ms" },
        { scenario: name, metric: "SSE e2e max", value: r3(e2e.max), unit: "ms" },
        {
          scenario: name,
          metric: "events missed per UI client",
          value: expected - delivered,
          unit: "events",
          threshold: { op: "==", value: 0, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "reconnecting client: events missed or duplicated",
          value: Math.abs(expected - reconnected),
          unit: "events",
          threshold: { op: "==", value: 0, source: "roadmap" },
          note: `dropped at ${firstLeg.events}, ${RECONNECT_PAUSE_MS} ms offline`,
        },
        {
          scenario: name,
          metric: "gap/error frames",
          value: gaps,
          unit: "count",
          threshold: { op: "==", value: 0, source: "guard" },
        },
        {
          scenario: name,
          metric: "event-loop delay p99",
          value: r3(loop.percentile(99) / 1e6),
          unit: "ms",
        },
      ];
      return out;
    } finally {
      clearInterval(driver);
      sub.close();
      for (const c of clients) c.close();
      secondLeg?.close();
      await server.close();
      cleanup();
    }
  },
};
