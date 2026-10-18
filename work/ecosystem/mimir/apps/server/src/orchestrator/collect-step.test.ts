import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH } from "../test-helpers.js";
import { ARTIFACT_COLLECTION_DIR } from "./collect.js";
import { writingRuntime } from "./test-agent-files.js";
import { createTask, harness, setupMission, type Harness } from "./test-harness.js";
import type { VerificationResult, Verifier } from "./verifier.js";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Passes, and records how many artifact.recorded events existed when it was called. */
class CountingVerifier implements Verifier {
  seenBefore = -1;
  constructor(private readonly h: () => Harness) {}
  verify(): Promise<VerificationResult> {
    this.seenBefore = this.h().events(["artifact.recorded"]).length;
    return Promise.resolve({ source: "test-command", passed: true, checks: [] });
  }
}

describe("verifying step collects <worktree>/.mimir/artifacts (T12b)", () => {
  it("records review, screenshot, log and other files before verification runs", async () => {
    const ref: { h?: Harness } = {};
    const verifier = new CountingVerifier(() => ref.h!);
    const h = await harness({
      overrides: { verifier },
      wrapRuntime: (fake) =>
        writingRuntime(fake, (cwd) => {
          const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, "review.json"),
            JSON.stringify({ verdict: "approve", token: "sk-abcdefghijklmnopqrstuvwxyz0123" }),
          );
          writeFileSync(join(dir, "screenshot-home.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          writeFileSync(join(dir, "vitest.log"), "10 passed\n");
          writeFileSync(join(dir, "notes.txt"), "hello\n");
        }),
    });
    ref.h = h;
    harnesses.push(h);
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");

    const collected = h
      .events(["artifact.recorded"])
      .filter((e) => (e.payload as { name?: string }).name !== undefined);
    expect(
      collected.map((e) => [
        (e.payload as { name: string }).name,
        (e.payload as { kind: string }).kind,
      ]),
    ).toEqual([
      ["notes.txt", "file"],
      ["review.json", "review"],
      ["screenshot-home.png", "screenshot"],
      ["vitest.log", "test.output"],
    ]);
    for (const e of collected) {
      expect(e).toMatchObject({ provenance: "observed", source: "mimir.server", taskId: t });
    }
    // collected in the verifying step, before the verifier ran
    expect(verifier.seenBefore).toBeGreaterThanOrEqual(collected.length);

    const review = collected.find((e) => (e.payload as { kind: string }).kind === "review")!;
    const id = (review.payload as { artifactId: string }).artifactId;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/artifacts/${id}/content`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("approve");
    expect(res.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(res.headers["x-artifact-hash"]).toBe((review.payload as { hash: string }).hash);
  }, 120_000);
});
