import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerificationReportSchema,
  canonicalJson,
  sha256Digest,
  type VerificationReport,
} from "@brokkr/core";
import {
  EVIDENCE_MANIFEST,
  collectArtifacts,
  createRun,
  defaultBrokkrHome,
  digestText,
  finalizeRun,
  gitEnv,
  listRuns,
  pruneRuns,
  readReport,
  signingKey,
  workspaceTreeDigest,
} from "./index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "brokkr-evidence-edges-"));

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

/** Re-sign an edited manifest with the installation key, as finalizeRun does. */
async function resign(path: string, edit: (m: Record<string, unknown>) => void): Promise<void> {
  const m = JSON.parse(readFileSync(path, "utf8"));
  edit(m);
  const body = canonicalJson({
    schemaVersion: m.schemaVersion,
    runId: m.runId,
    workspaceKey: m.workspaceKey,
    runsRoot: m.runsRoot,
    artifacts: m.artifacts,
  });
  m.signature = `hmac-sha256:${createHmac("sha256", await signingKey())
    .update(body)
    .digest("hex")}`;
  writeFileSync(path, JSON.stringify(m));
}

async function signedRun() {
  const ws = tmp();
  const run = await createRun(ws);
  await finalizeRun(run.dir, report(run.id), { workspace: ws });
  return { ws, run, manifestPath: join(run.dir, EVIDENCE_MANIFEST) };
}

const saved = { home: process.env.BROKKR_HOME, path: process.env.PATH };
afterEach(() => {
  process.env.BROKKR_HOME = saved.home;
  process.env.PATH = saved.path;
});

describe("store defaults", () => {
  it("defaultBrokkrHome falls back to the user's home directory without BROKKR_HOME", () => {
    expect(defaultBrokkrHome()).toBe(saved.home);
    delete process.env.BROKKR_HOME;
    expect(defaultBrokkrHome()).toBe(homedir());
  });

  it("gitEnv falls back to a minimal PATH", () => {
    expect(gitEnv().PATH).toBe(saved.path);
    delete process.env.PATH;
    expect(gitEnv().PATH).toBe("/usr/bin:/bin");
  });

  it("digestText is the sha256 digest of the text", () => {
    expect(digestText("abc")).toBe(sha256Digest("abc"));
    expect(digestText("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("createRun and signingKey edges", () => {
  it("refuses an explicit run id that is not run_<ULID>", async () => {
    await expect(createRun(tmp(), { runId: "../escape" })).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("concurrent first use creates one key and both callers get it", async () => {
    const home = tmp();
    const [a, b] = await Promise.all([signingKey(home), signingKey(home)]);
    expect(a.equals(b)).toBe(true);
    expect(readFileSync(join(home, ".brokkr", "key"), "utf8")).toBe(a.toString("hex"));
  });

  it("a key file that does not hold 32 hex bytes is an integrity error", async () => {
    const home = tmp();
    mkdirSync(join(home, ".brokkr"), { mode: 0o700 });
    writeFileSync(join(home, ".brokkr", "key"), "abcd\n", { mode: 0o600 });
    await expect(signingKey(home)).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("collectArtifacts edges", () => {
  it("skips missing artifact directories and special files", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "a.log"), "x");
    execFileSync("mkfifo", [join(dir, "logs", "pipe.log")]);
    const refs = await collectArtifacts(dir);
    expect(refs.map((r) => [r.path, r.kind, r.producedBy])).toEqual([["logs/a.log", "log", "a"]]);
  });
});

describe("workspaceTreeDigest edges", () => {
  it("a tree that starts with a symlink is digested by its target", async () => {
    const a = tmp();
    const b = tmp();
    symlinkSync("one", join(a, "link"));
    symlinkSync("two", join(b, "link"));
    const da = await workspaceTreeDigest(a);
    expect(da).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(da).not.toBe(await workspaceTreeDigest(b));
    const c = tmp();
    symlinkSync("one", join(c, "link"));
    expect(await workspaceTreeDigest(c)).toBe(da);
  });
});

describe("readReport bound-manifest checks", () => {
  it("flags a signed manifest whose run id differs from the report", async () => {
    const { run, manifestPath } = await signedRun();
    await resign(manifestPath, (m) => {
      m.runId = "run_00000000000000000000000000";
    });
    const read = await readReport(run.dir);
    expect(read.integrity.problems).toEqual(["manifest run id does not match the report"]);
  });

  it("flags a signed manifest that does not list report.json", async () => {
    const { run, manifestPath } = await signedRun();
    await resign(manifestPath, (m) => {
      m.artifacts = (m.artifacts as Array<{ path: string }>).filter(
        (a) => a.path !== "report.json",
      );
    });
    const read = await readReport(run.dir);
    expect(read.integrity.problems).toEqual(["report.json is not listed in the manifest"]);
  });
});

describe("listRuns and pruneRuns edges", () => {
  it("lists several runs newest first", async () => {
    const ws = tmp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await createRun(ws, { runId: `run_0000000000000000000000000${i}` });
      await finalizeRun(run.dir, report(run.id), { workspace: ws });
      ids.push(run.id);
    }
    expect((await listRuns(ws)).map((r) => r.id)).toEqual([...ids].reverse());
  });

  it("pruning a workspace that has no runs root removes nothing", async () => {
    expect(await pruneRuns(tmp(), { keep: 0 })).toEqual({ removed: [], kept: [] });
  });
});
