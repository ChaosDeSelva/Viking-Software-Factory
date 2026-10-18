import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openEventStore, type AppendInput, type EventStore } from "@mimir/core";
import { newId, type MissionId, type RuntimeAdapter, type SessionId } from "@mimir/protocol";
import type { BenchResult } from "@mimir/testing";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuildServerOptions } from "../src/index.js";

export const BENCH_TOKEN = "bench-token-0123456789abcdef";
export const BENCH_AUTH = { authorization: `Bearer ${BENCH_TOKEN}` };

/** Options every scenario receives from the runner. */
export interface ScenarioOptions {
  /** 1 = the full roadmap scenario; smaller values shrink counts and durations (smoke runs). */
  scale: number;
  log: (line: string) => void;
}

export interface Scenario {
  name: string;
  description: string;
  run(opts: ScenarioOptions): Promise<BenchResult[]>;
}

/** A temp directory removed by `cleanup`. */
export function tempDir(prefix = "mimir-bench-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A file-backed store (WAL, the production configuration) in a temp directory. */
export function tempFileStore(): { store: EventStore; path: string; cleanup: () => void } {
  const t = tempDir();
  const path = join(t.dir, "mimir.db");
  const store = openEventStore(path);
  return {
    store,
    path,
    cleanup: () => {
      store.close();
      t.cleanup();
    },
  };
}

export interface BenchServer {
  app: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

/** The real Fastify server, in process, listening on an ephemeral loopback port. */
export async function startServer(
  store: EventStore,
  overrides: Partial<BuildServerOptions> = {},
  runtime: RuntimeAdapter | null = null,
): Promise<BenchServer> {
  const app = buildServer({
    store,
    ledger: store.commands,
    audit: store.audit,
    runtime,
    authToken: BENCH_TOKEN,
    ...overrides,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

const TEXT = "compiling packages/core ... ok (12 files, 0 warnings) ".repeat(3);

/** A realistic `session.output` event for `sessionId` (about 400 bytes serialised). */
export function outputEvent(sessionId: SessionId, n: number, missionId?: MissionId): AppendInput {
  const now = new Date().toISOString();
  return {
    streamId: sessionId,
    occurredAt: now,
    observedAt: now,
    type: "session.output",
    source: "bench",
    provenance: "observed",
    sessionId,
    ...(missionId === undefined ? {} : { missionId }),
    payload: { text: `${n} ${TEXT}`, redacted: false, lines: 1 },
  };
}

/** A deterministic mix of mission, session and output events for log-size scenarios. */
export function mixedEvents(count: number): AppendInput[] {
  const out: AppendInput[] = [];
  const sessions = Array.from({ length: 20 }, () => newId("ses"));
  let missionId = newId("msn");
  for (let i = 0; i < count; i++) {
    const now = new Date().toISOString();
    if (i % 100 === 0) {
      missionId = newId("msn");
      out.push({
        streamId: missionId,
        occurredAt: now,
        observedAt: now,
        type: "mission.created",
        source: "bench",
        provenance: "observed",
        missionId,
        payload: { projectId: newId("prj"), objective: `objective ${i}` },
      });
      continue;
    }
    const sessionId = sessions[i % sessions.length] as SessionId;
    if (i % 10 === 1) {
      out.push({
        streamId: sessionId,
        occurredAt: now,
        observedAt: now,
        type: "session.state_changed",
        source: "bench",
        provenance: "observed",
        sessionId,
        missionId,
        payload: { from: "running", to: "idle" },
      });
      continue;
    }
    out.push(outputEvent(sessionId, i, missionId));
  }
  return out;
}

/** Appends `inputs` in transactions of `batch`. Returns elapsed milliseconds. */
export function appendInBatches(store: EventStore, inputs: AppendInput[], batch = 1000): number {
  const t0 = performance.now();
  for (let i = 0; i < inputs.length; i += batch) store.appendMany(inputs.slice(i, i + batch));
  return performance.now() - t0;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wall time of `fn` in milliseconds. */
export async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

/** Rounds to 3 decimals for stable tables. */
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
