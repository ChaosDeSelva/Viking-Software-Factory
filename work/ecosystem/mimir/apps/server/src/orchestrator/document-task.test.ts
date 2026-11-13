import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH } from "../test-helpers.js";
import { ARTIFACT_COLLECTION_DIR } from "./collect.js";
import { DOCUMENT_MISSING } from "./orchestrator.js";
import { writingRuntime } from "./test-agent-files.js";
import { harness, setupMission, type Harness, type Json } from "./test-harness.js";
import type { VerificationResult, Verifier } from "./verifier.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

class RecordingVerifier implements Verifier {
  calls = 0;
  verify(): Promise<VerificationResult> {
    this.calls += 1;
    return Promise.resolve({ source: "test-command", passed: true, checks: [] });
  }
}

const DOCUMENT = { deliverable: "document", access: "read", network: "web" } as const;

async function documentHarness(
  write: (cwd: string) => void,
  crew: { maxAttemptsPerTask?: number } = {},
): Promise<{ h: Harness; verifier: RecordingVerifier; missionId: string }> {
  const verifier = new RecordingVerifier();
  const h = await harness({
    overrides: { verifier },
    wrapRuntime: (fake) => writingRuntime(fake, write),
  });
  harnesses.push(h);
  const { missionId } = await setupMission(h, crew);
  return { h, verifier, missionId };
}

async function run(h: Harness, missionId: string, body: Record<string, unknown>): Promise<string> {
  const res = await h.post("/v1/tasks", { missionId, title: "Research", brief: "echo r", ...body });
  expect(res.status).toBe(201);
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  return res.json.task.id as string;
}

const collected = (h: Harness, taskId: string) =>
  h
    .events(["artifact.recorded"])
    .filter((e) => e.taskId === taskId)
    .map((e) => e.payload as { name?: string; kind: string; artifactId: string });

describe("document deliverable", () => {
  it("completes without verification, collects the report and keeps the base as result", async () => {
    const { h, verifier, missionId } = await documentHarness((cwd) => {
      const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "research.md"), "# Answer\n\nIt works [1].\n");
      writeFileSync(join(dir, "sources.json"), JSON.stringify([{ id: 1, kind: "url", ref: "x" }]));
      // A stray source edit: recorded for transparency, never committed as the result.
      writeFileSync(join(cwd, "package.json"), "{}\n");
    });
    const t = await run(h, missionId, { mode: DOCUMENT });

    const task = h.task(t);
    expect(task.status).toBe("completed");
    expect(task.mode).toEqual(DOCUMENT);
    expect(verifier.calls).toBe(0);
    expect(h.events(["test.run_completed"])).toHaveLength(0);

    const worktree = [...h.app.mimir.readModel.worktrees.values()].find((w) => w.taskId === t)!;
    expect(task.resultCommit).toBe(worktree.baseSha);
    const completed = h.events(["task.completed"]).find((e) => e.taskId === t)!;
    expect(completed.payload).toMatchObject({
      resultCommit: worktree.baseSha,
      verificationSkipped: "document_deliverable",
    });

    const artifacts = collected(h, t);
    expect(artifacts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["diff", "changed-files", "report", "file"]),
    );
    const content = async (name: string) => {
      const a = artifacts.find((x) => x.name === name)!;
      return h.app.inject({
        method: "GET",
        url: `/v1/artifacts/${a.artifactId}/content`,
        headers: AUTH,
      });
    };
    const report = await content("research.md");
    expect(artifacts.find((a) => a.name === "research.md")!.kind).toBe("report");
    expect(report.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(report.body).toContain("It works [1].");
    const sources = await content("sources.json");
    expect(sources.headers["content-type"]).toBe("application/json");
    expect(sources.json()).toEqual([{ id: 1, kind: "url", ref: "x" }]);

    const pr = await h.post(`/v1/tasks/${t}/pr`, {});
    expect(pr.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it("fails with document_missing when no .md report was left", async () => {
    const { h, verifier, missionId } = await documentHarness(
      (cwd) => {
        const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "notes.txt"), "no report\n");
      },
      { maxAttemptsPerTask: 1 },
    );
    const t = await run(h, missionId, { mode: { deliverable: "document" } });

    expect(h.task(t).status).toBe("failed");
    expect(h.task(t).resultCommit).toBeUndefined();
    expect(verifier.calls).toBe(0);
    const failed = h.events(["task.failed"]).find((e) => e.taskId === t)!;
    expect(failed.payload).toMatchObject({ reason: DOCUMENT_MISSING, retryable: false });
    // what it did leave is still recorded
    expect(collected(h, t).map((a) => a.name)).toContain("notes.txt");
  }, 120_000);

  it("leaves a task created without mode unchanged", async () => {
    const { h, verifier, missionId } = await documentHarness(() => undefined);
    const t = await run(h, missionId, {});

    const task = h.task(t);
    expect(task.status).toBe("completed");
    expect(task.mode).toBeUndefined();
    expect(verifier.calls).toBe(1);
    const completed = h.events(["task.completed"]).find((e) => e.taskId === t)!;
    expect((completed.payload as Json).verificationSkipped).toBeUndefined();
    expect(h.events(["task.created"]).find((e) => e.taskId === t)!.payload).not.toHaveProperty(
      "mode",
    );
    const res = await h.get(`/v1/tasks/${t}`);
    expect(res.json.task).not.toHaveProperty("mode");
  }, 120_000);

  it("persists mode on task.created and exposes it on the task read model", async () => {
    const { h, missionId } = await documentHarness(() => undefined);
    const res = await h.post("/v1/tasks", {
      missionId,
      title: "Review",
      brief: "echo r",
      mode: { deliverable: "document", access: "read" },
    });
    expect(res.status).toBe(201);
    const resolved = { deliverable: "document", access: "read", network: "none" };
    expect(res.json.task.mode).toEqual(resolved);
    const id = res.json.task.id as string;
    expect(h.events(["task.created"]).find((e) => e.taskId === id)!.payload).toMatchObject({
      mode: resolved,
    });
    expect((await h.get(`/v1/tasks/${id}`)).json.task.mode).toEqual(resolved);
  }, 120_000);

  it("completes a review deliverable (review.json, no .md) and serves it as JSON", async () => {
    const { h, verifier, missionId } = await documentHarness((cwd) => {
      const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "review.json"), JSON.stringify({ verdict: "comment", findings: [] }));
    });
    const t = await run(h, missionId, { mode: { deliverable: "document", access: "read" } });

    expect(h.task(t).status).toBe("completed");
    expect(verifier.calls).toBe(0);
    const review = collected(h, t).find((a) => a.kind === "review")!;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/artifacts/${review.artifactId}/content`,
      headers: AUTH,
    });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.json()).toEqual({ verdict: "comment", findings: [] });
  }, 120_000);

  it("refuses read access with a diff deliverable", async () => {
    const { h, missionId } = await documentHarness(() => undefined);
    for (const mode of [{ access: "read" }, { access: "read", deliverable: "diff" }]) {
      const res = await h.post("/v1/tasks", { missionId, title: "R", brief: "echo r", mode });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.json)).toContain('deliverable \\"document\\"');
    }
  }, 120_000);
});
