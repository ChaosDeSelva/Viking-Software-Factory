/**
 * Chaos: hostile `<worktree>/.mimir/artifacts/` content left by an agent, collected by the
 * orchestrator's verifying step (T12b). The FakeRuntime runs no process, so `writingRuntime`
 * plays the agent's writes when the session starts in the worktree.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_COLLECTION_DIR } from "../../src/orchestrator/collect.js";
import { writingRuntime } from "../../src/orchestrator/test-agent-files.js";
import {
  createTask,
  harness,
  setupMission,
  type Harness,
} from "../../src/orchestrator/test-harness.js";
import type { VerificationResult } from "../../src/orchestrator/verifier.js";

const PASS: VerificationResult = { source: "test-command", passed: true, checks: [] };
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Runs one task whose agent writes `files(dir)` into .mimir/artifacts; returns its events. */
async function runWith(
  files: (dir: string) => void,
): Promise<{ h: Harness; events: EventEnvelope[] }> {
  const h = await harness({
    overrides: { verifier: { verify: () => Promise.resolve(PASS) } },
    wrapRuntime: (fake) =>
      writingRuntime(fake, (cwd) => {
        const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
        mkdirSync(dir, { recursive: true });
        files(dir);
      }),
  });
  harnesses.push(h);
  const { missionId } = await setupMission(h);
  const t = await createTask(h, missionId, "T", "echo t");
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  expect(h.task(t).status).toBe("completed");
  return { h, events: h.events().filter((e) => e.taskId === t) };
}

const collected = (events: EventEnvelope[]) =>
  events.filter(
    (e) => e.type === "artifact.recorded" && (e.payload as { name?: string }).name !== undefined,
  );

describe("chaos: artifact collection", () => {
  it("refuses a symlink to /etc/passwd and stores none of its bytes", async () => {
    const passwd = readFileSync("/etc/passwd", "utf8");
    const { h, events } = await runWith((dir) => {
      symlinkSync("/etc/passwd", join(dir, "passwd.log"));
      symlinkSync("/etc/passwd", join(dir, "review.json"));
      writeFileSync(join(dir, "ok.log"), "fine\n");
    });
    expect(collected(events).map((e) => (e.payload as { name: string }).name)).toEqual(["ok.log"]);
    const skipped = events.filter((e) => e.type === "artifact.collection_skipped");
    expect(skipped.map((e) => e.payload)).toEqual([
      expect.objectContaining({ name: "passwd.log", reason: "symlink" }),
      expect.objectContaining({ name: "review.json", reason: "symlink" }),
    ]);
    for (const e of skipped) expect(e).toMatchObject({ provenance: "observed" });
    // nothing in Mimir's artifact store holds the passwd content
    for (const e of h.events(["artifact.recorded"])) {
      const id = (e.payload as { artifactId: string }).artifactId;
      const bytes = h.app.mimir.artifacts.read(id);
      expect(bytes?.toString("utf8") ?? "").not.toContain(passwd.slice(0, 64));
    }
  }, 180_000);

  it("refuses a symlinked .mimir directory pointing outside the worktree", async () => {
    let outside = "";
    const h = await harness({
      overrides: { verifier: { verify: () => Promise.resolve(PASS) } },
      wrapRuntime: (fake) =>
        writingRuntime(fake, (cwd) => {
          outside = join(cwd, "..", `outside-${Date.now()}`);
          mkdirSync(join(outside, "artifacts"), { recursive: true });
          writeFileSync(join(outside, "artifacts", "review.json"), "{}");
          symlinkSync(outside, join(cwd, ".mimir"));
        }),
    });
    harnesses.push(h);
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    const events = h.events().filter((e) => e.taskId === t);
    expect(collected(events)).toEqual([]);
    expect(
      events.filter((e) => e.type === "artifact.collection_skipped").map((e) => e.payload),
    ).toEqual([expect.objectContaining({ name: ".mimir", reason: "symlink" })]);
  }, 180_000);

  it("skips a file over 8 MB with a reason event and still records the rest", async () => {
    const { events } = await runWith((dir) => {
      writeFileSync(join(dir, "huge.log"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
      writeFileSync(join(dir, "small.log"), "ok\n");
    });
    expect(collected(events).map((e) => (e.payload as { name: string }).name)).toEqual([
      "small.log",
    ]);
    expect(
      events.filter((e) => e.type === "artifact.collection_skipped").map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({
        name: "huge.log",
        reason: "file_too_large",
        bytes: 8 * 1024 * 1024 + 1,
        limitBytes: 8 * 1024 * 1024,
      }),
    ]);
  }, 180_000);

  it("201 files -> the first 200 recorded plus artifact.collection_truncated", async () => {
    const { events } = await runWith((dir) => {
      for (let i = 0; i < 201; i++)
        writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), `${i}`);
    });
    const names = collected(events).map((e) => (e.payload as { name: string }).name);
    expect(names).toHaveLength(200);
    expect(names[0]).toBe("f000.txt");
    expect(names.at(-1)).toBe("f199.txt");
    expect(names).not.toContain("f200.txt");
    const truncated = events.filter((e) => e.type === "artifact.collection_truncated");
    expect(truncated.map((e) => e.payload)).toEqual([
      expect.objectContaining({ found: 201, kept: 200, limit: 200 }),
    ]);
  }, 180_000);
});
