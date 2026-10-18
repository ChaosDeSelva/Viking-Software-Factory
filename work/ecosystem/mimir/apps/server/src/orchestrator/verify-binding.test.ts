import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTask,
  harness as baseHarness,
  setupMission,
  type Harness,
  type HarnessOptions,
} from "./test-harness.js";
import type { VerificationResult, Verifier, VerifyInput } from "./verifier.js";

const harnesses: Harness[] = [];
const track = async (opts: HarnessOptions = {}) => {
  const h = await baseHarness({
    ...opts,
  });
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Records every input and answers with a fixed verdict. */
class RecordingVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  constructor(private readonly result: VerificationResult) {}
  verify(input: VerifyInput): Promise<VerificationResult> {
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }
}

const PASS: VerificationResult = { source: "test-command", passed: true, checks: [] };

async function runOneTask(h: Harness): Promise<string> {
  const { missionId } = await setupMission(h);
  const t = await createTask(h, missionId, "T", "echo t");
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  return t;
}

describe("VerifyInput binding (T12b)", () => {
  it("carries taskId, missionId, worktree, baseRef and the observed headSha", async () => {
    const verifier = new RecordingVerifier(PASS);
    const h = await track({ overrides: { verifier } });
    const t = await runOneTask(h);
    expect(h.task(t).status).toBe("completed");
    expect(verifier.inputs).toHaveLength(1);
    const input = verifier.inputs[0]!;
    const task = h.task(t);
    const worktree = [...h.app.mimir.readModel.worktrees.values()].find((w) => w.taskId === t)!;
    expect(input).toMatchObject({
      taskId: t,
      missionId: task.missionId,
      worktreePath: worktree.path,
      baseRef: worktree.baseSha,
    });
    expect(input.headSha).toMatch(/^[0-9a-f]{40}$/);
    // the head is the one recorded in the same step's changed-files manifest
    const manifestEvent = h
      .events(["artifact.recorded"])
      .find((e) => (e.payload as { kind: string }).kind === "changed-files")!;
    const uri = (manifestEvent.payload as { uri: string }).uri;
    const manifest = JSON.parse(readFileSync(fileURLToPath(uri), "utf8")) as { headSha: string };
    expect(input.headSha).toBe(manifest.headSha);
  }, 120_000);
});
