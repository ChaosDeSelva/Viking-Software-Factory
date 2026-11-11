import { describe, expect, it } from "vitest";
import { parseVerificationReport, sameCommit } from "./brokkr-report.js";
import {
  evidenceTrust,
  manifestHead,
  manifestOfVerifyingStep,
  readVerifiedArtifact,
  recordedArtifacts,
  sha256Of,
  testRuns,
} from "./evidence.js";
import type { ExecutionEventView, MimirArtifactView } from "./ports.js";

let seq = 0;
const event = (
  type: string,
  payload: unknown,
  over: Partial<ExecutionEventView> = {},
): ExecutionEventView => ({
  mimirEventId: `evt_${++seq}`,
  type,
  payload,
  occurredAt: "2026-10-14T10:00:00.000Z",
  mimirTaskId: "mt_1",
  sessionId: null,
  source: "mimir.server",
  provenance: "observed",
  ...over,
});

const recorded = (payload: Record<string, unknown>, over: Partial<ExecutionEventView> = {}) =>
  event(
    "artifact.recorded",
    {
      artifactId: "art_1",
      taskId: "mt_1",
      kind: "diff",
      uri: "file:///a",
      hash: "sha256:x",
      ...payload,
    },
    over,
  );

describe("recordedArtifacts and testRuns: malformed payloads", () => {
  it("skips artifact events with a payload that is not an object or misses a field", () => {
    expect(
      recordedArtifacts([
        event("artifact.recorded", "not an object"),
        recorded({ uri: 7 }),
        recorded({ hash: undefined }),
        recorded({ artifactId: "art_ok" }),
      ]).map((a) => a.artifactId),
    ).toEqual(["art_ok"]);
  });

  it("skips runs without a command or a boolean result, and keeps optional numbers absent", () => {
    const runs = testRuns([
      event("test.run_completed", null),
      event("test.run_completed", { command: 1, passed: true }),
      event("test.run_completed", { command: "pnpm test", passed: "yes" }),
      event("test.run_completed", { command: "pnpm test", passed: true, exitCode: "0" }),
    ]);
    expect(runs).toEqual([
      expect.objectContaining({
        command: "pnpm test",
        passed: true,
        exitCode: null,
        durationMs: null,
      }),
    ]);
  });

  it("with trust, counts only observed runs", () => {
    const trust = evidenceTrust();
    expect(
      testRuns(
        [event("test.run_completed", { command: "c", passed: true }, { provenance: "derived" })],
        trust,
      ),
    ).toEqual([]);
  });
});

describe("manifestOfVerifyingStep and manifestHead", () => {
  it("ignores other tasks and untrusted events, and resets at each verifying step", () => {
    const trust = evidenceTrust();
    const old = recorded({ artifactId: "art_old", kind: "changed-files" });
    const events = [
      old,
      event("task.verifying", {}),
      recorded(
        { artifactId: "art_other", kind: "changed-files", taskId: "mt_2" },
        { mimirTaskId: "mt_2" },
      ),
      recorded({ artifactId: "art_forged", kind: "changed-files" }, { source: "agent:claude" }),
      recorded({ artifactId: "art_diff", kind: "diff" }),
    ];
    const report = recorded({ artifactId: "art_report", kind: "brokkr.verification-report" });
    expect(
      manifestOfVerifyingStep([...events, report], "mt_1", report.mimirEventId, trust),
    ).toBeNull();
    // Without the reset, the manifest of the earlier step is the one in effect.
    expect(
      manifestOfVerifyingStep([old, report], "mt_1", report.mimirEventId, trust)?.artifactId,
    ).toBe("art_old");
  });

  it("reads a head only from a JSON object with a hex sha", () => {
    expect(manifestHead('{"headSha":"abc1234"}')).toBe("abc1234");
    expect(manifestHead('{"headSha":"main"}')).toBeNull();
    expect(manifestHead('["abc1234"]')).toBeNull();
    expect(manifestHead("{")).toBeNull();
  });
});

describe("readVerifiedArtifact: failures", () => {
  const artifact: MimirArtifactView = {
    id: "art_1",
    taskId: "mt_1",
    kind: "diff",
    uri: "file:///a",
    hash: `sha256:${sha256Of("bytes")}`,
  };
  const mimir = { getArtifact: () => Promise.resolve(artifact) };

  it("is unavailable when Mimir or the content read fails, whatever is thrown", async () => {
    expect(
      await readVerifiedArtifact(
        { getArtifact: () => Promise.reject("refused") },
        { read: () => Promise.resolve("bytes") },
        "art_1",
      ),
    ).toEqual({ ok: false, reason: "artifact_unavailable", detail: "refused" });
    expect(
      await readVerifiedArtifact(mimir, { read: () => Promise.reject(new Error("gone")) }, "art_1"),
    ).toEqual({ ok: false, reason: "artifact_unavailable", detail: "gone" });
  });

  it("rejects bytes when the recorded hash is not SHA-256", async () => {
    const md5 = { getArtifact: () => Promise.resolve({ ...artifact, hash: "md5:abc" }) };
    expect(
      await readVerifiedArtifact(md5, { read: () => Promise.resolve("bytes") }, "art_1"),
    ).toMatchObject({ ok: false, reason: "evidence_integrity_mismatch" });
    expect(
      await readVerifiedArtifact(mimir, { read: () => Promise.resolve("bytes") }, "art_1", {
        taskId: "mt_1",
        kind: "diff",
      }),
    ).toMatchObject({ ok: true, text: "bytes" });
  });
});

describe("Brokkr report helpers: edges", () => {
  it("names the root when the report is not an object", () => {
    expect(parseVerificationReport("5")).toEqual({
      ok: false,
      error: expect.stringMatching(/^\(root\): /),
    });
  });

  it("never matches a sha shorter than seven characters", () => {
    expect(sameCommit("abc12", "abc12")).toBe(false);
    expect(sameCommit("ABC1234def", " abc1234 ")).toBe(true);
  });
});
