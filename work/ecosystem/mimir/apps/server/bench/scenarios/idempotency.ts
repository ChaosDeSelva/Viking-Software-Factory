import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { summarize, type BenchResult } from "@mimir/testing";
import { BENCH_AUTH, r3, startServer, tempDir, tempFileStore, type Scenario } from "../harness.js";

const FULL_PARALLEL = 200;

interface Outcome {
  status: number;
  replayed: boolean;
  ms: number;
}

/**
 * Scenario 5: the idempotency plugin under 200 parallel identical `POST /v1/projects` (same
 * Idempotency-Key, same body) over real sockets, then a second wave after the first settled.
 * Exactly one request may execute; the rest replay it or get 409 `conflict` while it is in flight.
 */
export const idempotency: Scenario = {
  name: "idempotency",
  description: "200 parallel identical POSTs with one Idempotency-Key",
  async run({ scale, log }) {
    const parallel = Math.max(10, Math.round(FULL_PARALLEL * scale));
    const { store, cleanup } = tempFileStore();
    const repoDir = tempDir();
    const repo = join(realpathSync(repoDir.dir), "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const server = await startServer(store);
    const name = "5 idempotency";
    const post = async (): Promise<Outcome> => {
      const t0 = performance.now();
      const res = await fetch(`${server.url}/v1/projects`, {
        method: "POST",
        headers: {
          ...BENCH_AUTH,
          "content-type": "application/json",
          "idempotency-key": "bench-1",
        },
        body: JSON.stringify({ name: "bench", repoPath: repo }),
      });
      await res.arrayBuffer();
      return {
        status: res.status,
        replayed: res.headers.get("idempotency-replayed") === "true",
        ms: performance.now() - t0,
      };
    };
    try {
      log(`  idempotency: ${parallel} parallel POSTs, twice`);
      const wave1 = await Promise.all(Array.from({ length: parallel }, post));
      const wave2 = await Promise.all(Array.from({ length: parallel }, post));
      const all = [...wave1, ...wave2];
      const executed = all.filter((o) => o.status === 201 && !o.replayed).length;
      const unexpected = all.filter(
        (o) => !(o.status === 201 || (o.status === 409 && !o.replayed)),
      ).length;
      const projects = (
        (await (await fetch(`${server.url}/v1/projects`, { headers: BENCH_AUTH })).json()) as {
          projects: unknown[];
        }
      ).projects.length;
      const audits = store.audit.list().filter((a) => a.action === "project.create").length;
      const w1 = summarize(wave1.map((o) => o.ms));
      const w2 = summarize(wave2.map((o) => o.ms));
      const results: BenchResult[] = [
        {
          scenario: name,
          metric: "requests executed (not replayed)",
          value: executed,
          unit: "requests",
          threshold: { op: "==", value: 1, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "projects created",
          value: projects,
          unit: "projects",
          threshold: { op: "==", value: 1, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "project.create audit entries",
          value: audits,
          unit: "entries",
          threshold: { op: "==", value: 1, source: "guard" },
        },
        {
          scenario: name,
          metric: "unexpected statuses (not 201/409)",
          value: unexpected,
          unit: "responses",
          threshold: { op: "==", value: 0, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "wave 1: 409 in-flight",
          value: wave1.filter((o) => o.status === 409).length,
          unit: "responses",
        },
        {
          scenario: name,
          metric: "wave 1: 201 replayed",
          value: wave1.filter((o) => o.replayed).length,
          unit: "responses",
        },
        { scenario: name, metric: "wave 1 latency p95", value: r3(w1.p95), unit: "ms" },
        {
          scenario: name,
          metric: "wave 2: 201 replayed",
          value: wave2.filter((o) => o.replayed).length,
          unit: "responses",
          threshold: { op: "==", value: parallel, source: "guard" },
        },
        {
          scenario: name,
          metric: "wave 2 latency p95",
          value: r3(w2.p95),
          unit: "ms",
          threshold: { op: "<", value: 1000, source: "guard" },
        },
      ];
      return results;
    } finally {
      await server.close();
      cleanup();
      repoDir.cleanup();
    }
  },
};
