import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "@mimir/protocol";
import { runMimirToExit, spawnMimir, type MimirProcess } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN, bearer, fixture, readAllEvents, serverSpawn, tempDataDir } from "./support.js";

const procs: MimirProcess[] = [];
const dirs: { cleanup: () => void }[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill("SIGKILL");
  for (const d of dirs.splice(0)) d.cleanup();
});
const dataDir = () => {
  const d = tempDataDir();
  dirs.push(d);
  return d.dir;
};
const track = (p: MimirProcess) => (procs.push(p), p);
const PRODUCER = fixture("producer.ts");

const producedIds = (events: EventEnvelope[]) =>
  events.filter((e) => e.source === "chaos-producer").map((e) => e.sourceEventId as string);

/** Asserts gap-free per-stream sequences starting at 1 and no repeated event ids. */
function expectConsistentLog(events: EventEnvelope[], cursors: string[]): void {
  expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  const byStream = new Map<string, number[]>();
  for (const e of events)
    byStream.set(e.streamId, [...(byStream.get(e.streamId) ?? []), e.sequence]);
  for (const seqs of byStream.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  expect(new Set(cursors).size).toBe(cursors.length);
}

describe("chaos: server process", () => {
  it("main.ts reports the port it actually bound when MIMIR_PORT=0", async () => {
    const p = track(await spawnMimir(serverSpawn(MAIN, dataDir())));
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(p.url).not.toMatch(/:0$/);
    const res = await fetch(`${p.url}/v1/capabilities`, { headers: bearer(p.token) });
    expect(res.status).toBe(200);
  });

  it("SIGKILL mid-write, restart on the same data dir: no lost and no duplicated durable events", async () => {
    const dir = dataDir();
    // Run 1: produce continuously, SIGKILL while appends are in flight.
    const run1 = track(await spawnMimir(serverSpawn(PRODUCER, dir, { CHAOS_EVENTS: "200000" })));
    await run1.waitForLine(/^ack 1000$/, 30_000);
    const exit1 = await run1.kill("SIGKILL");
    expect(exit1.signal).toBe("SIGKILL");
    const acked = run1
      .output()
      .split("\n")
      .filter((l) => /^ack \d+$/.test(l))
      .map((l) => Number(l.slice(4)));
    expect(run1.output()).not.toContain("producer done");

    // Run 2: restart without producing; everything acknowledged before the kill is there,
    // as a contiguous prefix (no holes), each exactly once.
    // Restart immediately: the dead owner's lock is reclaimed at once (no 5 s wait, no retry).
    const restartAt = Date.now();
    const run2 = track(await spawnMimir(serverSpawn(PRODUCER, dir)));
    expect(Date.now() - restartAt).toBeLessThan(4000);
    const after = await readAllEvents(run2.url, run2.token);
    const ids = producedIds(after.events);
    const stored = ids.length;
    expect(stored).toBeGreaterThanOrEqual(Math.max(...acked) + 1);
    expect(ids).toEqual(Array.from({ length: stored }, (_, i) => `p-${i}`));
    expectConsistentLog(after.events, after.cursors);
    const idsBefore = new Map(after.events.map((e) => [e.sourceEventId, e.id]));
    await run2.kill("SIGKILL");

    // Run 3: the producer re-delivers everything from 0 and continues past the old end.
    const total = stored + 300;
    const run3 = track(
      await spawnMimir(serverSpawn(PRODUCER, dir, { CHAOS_EVENTS: String(total) })),
    );
    await run3.waitForLine(/^producer done$/, 30_000);
    const final = await readAllEvents(run3.url, run3.token);
    expect(producedIds(final.events)).toEqual(Array.from({ length: total }, (_, i) => `p-${i}`));
    expectConsistentLog(final.events, final.cursors);
    // Events stored before the crash kept their identity (re-delivery deduped, not re-inserted).
    for (const e of final.events.slice(0, stored)) {
      expect(e.id).toBe(idsBefore.get(e.sourceEventId));
    }
  });

  it("SIGKILL after a command: restart keeps the project and replays its Idempotency-Key", async () => {
    const dir = dataDir();
    const repo = join(dir, "..", `${dir.split("/").at(-1)}-repo`);
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(repo);
    dirs.push({ cleanup: () => rmSync(repo, { recursive: true, force: true }) });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const post = (url: string, token: string) =>
      fetch(`${url}/v1/projects`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json", "idempotency-key": "k1" },
        body: JSON.stringify({ name: "p", repoPath: repo }),
      });
    const run1 = track(await spawnMimir(serverSpawn(MAIN, dir)));
    const first = await post(run1.url, run1.token);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { project: { id: string } };
    await run1.kill("SIGKILL");

    const run2 = track(await spawnMimir(serverSpawn(MAIN, dir)));
    const again = await post(run2.url, run2.token);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(((await again.json()) as { project: { id: string } }).project.id).toBe(
      created.project.id,
    );
    const list = await fetch(`${run2.url}/v1/projects`, { headers: bearer(run2.token) });
    expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  });

  it("a second server on the same data dir refuses to start; the first keeps serving", async () => {
    const dir = dataDir();
    const first = track(await spawnMimir(serverSpawn(MAIN, dir)));
    const second = await runMimirToExit(serverSpawn(MAIN, dir));
    expect(second.code).not.toBe(0);
    expect(second.output).toMatch(/another Mimir server owns this database/);
    expect(second.output).not.toMatch(/listening on/);
    const res = await fetch(`${first.url}/v1/events`, { headers: bearer(first.token) });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, "mimir.db.lock"))).toBe(true);
  });
});
