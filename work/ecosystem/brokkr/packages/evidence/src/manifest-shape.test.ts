import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerificationReportSchema, type VerificationReport } from "@brokkr/core";
import { EVIDENCE_MANIFEST, createRun, finalizeRun, listRuns, readReport } from "./index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "brokkr-evidence-shape-"));
}

function report(id: string): VerificationReport {
  return VerificationReportSchema.parse({
    schemaVersion: "1.0",
    id,
    harness: { name: "h", version: "1.0.0", lockDigest: `sha256:${"a".repeat(64)}` },
    harnesses: [],
    repository: { commitSha: "abc" },
    startedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:01.000Z",
    verdict: "passed",
    reasons: [],
    checks: [],
    policyDecisions: [],
    exceptions: [],
    evidence: [],
    summary: { passed: 0, failed: 0, skipped: 0, errored: 0 },
    environment: { brokkrVersion: "0.1.0", node: "v25", platform: "darwin", arch: "arm64" },
    warnings: [],
  });
}

async function signedRun() {
  const ws = tmp();
  const run = await createRun(ws);
  writeFileSync(run.logPath("tests"), "ok\n");
  await finalizeRun(run.dir, report(run.id), { workspace: ws });
  return { ws, run, manifestPath: join(run.dir, EVIDENCE_MANIFEST) };
}

describe("readReport treats every malformed manifest as an integrity problem", () => {
  it.each(["null", "false", "0", '""', "[]", '"text"'])(
    "a manifest of %s fails integrity instead of verifying nothing",
    async (body) => {
      const { ws, run, manifestPath } = await signedRun();
      // With the manifest neutralised, a tampered report must not read as intact.
      const reportPath = join(run.dir, "report.json");
      writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace('"passed"', '"failed"'));
      writeFileSync(manifestPath, body);
      const read = await readReport(run.dir);
      expect(read.integrity.status).toBe("integrity_failed");
      expect(read.integrity.problems.join("\n")).toMatch(/evidence-manifest\.json/);
      await expect(readReport(run.dir, { strict: true })).rejects.toMatchObject({
        code: "integrity",
      });
      expect(await listRuns(ws)).toEqual([]);
    },
  );

  it.each([
    ["a null artifact", (m: Record<string, unknown[]>) => m.artifacts!.push(null)],
    ["a string artifact", (m: Record<string, unknown[]>) => m.artifacts!.push("logs/x.log")],
    [
      "an artifact with a numeric path",
      (m: Record<string, unknown[]>) => m.artifacts!.push({ path: 7, sha256: "sha256:00" }),
    ],
    [
      "an artifact without a digest",
      (m: Record<string, unknown[]>) => m.artifacts!.push({ path: "logs/tests.log" }),
    ],
  ])("%s is an integrity problem, not a crash", async (_label, mutate) => {
    const { run, manifestPath } = await signedRun();
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(m);
    writeFileSync(manifestPath, JSON.stringify(m));
    const read = await readReport(run.dir);
    expect(read.integrity.status).toBe("integrity_failed");
    expect(read.integrity.problems.join("\n")).toMatch(/malformed artifact entry/);
  });

  it.each([7, { a: 1 }, ["x"]])(
    "a non-string signature (%j) is a signature problem, not a crash",
    async (signature) => {
      const { run, manifestPath } = await signedRun();
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      m.signature = signature;
      writeFileSync(manifestPath, JSON.stringify(m));
      const read = await readReport(run.dir);
      expect(read.integrity.status).toBe("integrity_failed");
      expect(read.integrity.problems.join("\n")).toMatch(/signature mismatch/);
    },
  );
});
