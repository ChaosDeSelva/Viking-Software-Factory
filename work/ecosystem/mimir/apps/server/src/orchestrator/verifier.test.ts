import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CHECK_OUTPUT, TestCommandVerifier, headAndTail } from "./verifier.js";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mimir-verify-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const bind = (worktreePath: string) => ({
  taskId: "tsk_01J0000000000000000000000A",
  missionId: "msn_01J0000000000000000000000B",
  worktreePath,
  baseRef: "a".repeat(40),
  headSha: null,
});

describe("TestCommandVerifier", () => {
  it("passes on exit 0 and reports the check", async () => {
    const r = await new TestCommandVerifier().verify({
      ...bind(tmp()),
      testCommand: ["sh", "-c", "echo all good"],
      signal: signal(),
    });
    expect(r).toMatchObject({ source: "test-command", passed: true });
    expect(r.checks).toEqual([
      expect.objectContaining({
        command: ["sh", "-c", "echo all good"],
        passed: true,
        exitCode: 0,
        timedOut: false,
      }),
    ]);
    expect(r.checks[0]?.output).toContain("all good");
  });

  it("fails on a non-zero exit and runs in the worktree with a scrubbed env", async () => {
    process.env["MIMIR_VERIFY_SECRET"] = "s3cret";
    try {
      const dir = tmp();
      const r = await new TestCommandVerifier().verify({
        ...bind(dir),
        testCommand: ["sh", "-c", 'pwd; echo "secret=[$MIMIR_VERIFY_SECRET]"; exit 3'],
        signal: signal(),
      });
      expect(r.passed).toBe(false);
      expect(r.checks[0]).toMatchObject({ exitCode: 3, passed: false });
      expect(r.checks[0]?.output).toContain(dir);
      expect(r.checks[0]?.output).toContain("secret=[]");
    } finally {
      delete process.env["MIMIR_VERIFY_SECRET"];
    }
  });

  it("caps the reported output", async () => {
    const r = await new TestCommandVerifier().verify({
      ...bind(tmp()),
      testCommand: ["sh", "-c", `head -c ${MAX_CHECK_OUTPUT * 2} /dev/zero | tr '\\0' x`],
      signal: signal(),
    });
    expect(r.checks[0]!.output.length).toBeLessThanOrEqual(MAX_CHECK_OUTPUT + 64);
    expect(r.checks[0]!.output).toMatch(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
  });

  it("says so when the command printed more than could be captured", async () => {
    const r = await new TestCommandVerifier().verify({
      ...bind(tmp()),
      // More than @mimir/git's capture limit (1 MiB): the rest is gone, not just omitted.
      testCommand: ["sh", "-c", "head -c 2097152 /dev/zero | tr '\\0' x"],
      signal: signal(),
    });
    expect(r.checks[0]!.output.endsWith("\n[truncated]")).toBe(true);
    expect(r.checks[0]!.output.length).toBeLessThanOrEqual(MAX_CHECK_OUTPUT + 128);
  });

  it("keeps the start and the end of an output over the cap", () => {
    expect(headAndTail("short", 100)).toBe("short");
    const text = `START${"é".repeat(5000)}END`;
    const kept = headAndTail(text, 1000);
    expect(kept.length).toBeLessThanOrEqual(1000);
    expect(kept.startsWith("START")).toBe(true);
    expect(kept.endsWith("END")).toBe(true);
    const [, omitted] = /\n\[\.\.\. (\d+) bytes omitted \.\.\.\]\n/.exec(kept)!;
    const shown = kept.replace(/\n\[.*\]\n/, "");
    expect(Number(omitted)).toBe(Buffer.byteLength(text) - Buffer.byteLength(shown));
    // The end is at least what the read model quotes in the next attempt's brief.
    expect(kept.slice(-400)).toBe(text.slice(-400));
  });

  it("requires a test command and refuses to start when already aborted", async () => {
    const v = new TestCommandVerifier();
    await expect(v.verify({ ...bind(tmp()), signal: signal() })).rejects.toMatchObject({
      code: "validation_failed",
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      v.verify({ ...bind(tmp()), testCommand: ["true"], signal: ac.signal }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("TestCommandVerifier with project settings", () => {
  it("kills the running command when the verification is aborted", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = new TestCommandVerifier().verify({
      ...bind(tmp()),
      testCommand: ["sh", "-c", "sleep 30 & wait"],
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 300);
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("runs the command with the project's environment and time limit", async () => {
    const path = `/opt/tools/bin:${process.env["PATH"] ?? ""}`;
    const r = await new TestCommandVerifier().verify({
      ...bind(tmp()),
      testCommand: ["sh", "-c", 'echo "cache=[$GOCACHE] path=[$PATH]"'],
      env: { GOCACHE: "/var/cache/go", PATH: path },
      signal: signal(),
    });
    expect(r.checks[0]?.output).toContain(`cache=[/var/cache/go] path=[${path}]`);
    // The project's limit wins over the verifier's own.
    const slow = await new TestCommandVerifier({ timeoutMs: 60_000 }).verify({
      ...bind(tmp()),
      testCommand: ["sleep", "30"],
      timeoutMs: 300,
      signal: signal(),
    });
    expect(slow.checks[0]).toMatchObject({ passed: false, timedOut: true, exitCode: null });
  });
});

describe("TestCommandVerifier binding (T12b)", () => {
  it("passes taskId, missionId, worktree, baseRef and headSha through unchanged", async () => {
    const dir = tmp();
    const binding = {
      taskId: "tsk_01J0000000000000000000000A",
      missionId: "msn_01J0000000000000000000000B",
      worktreePath: dir,
      baseRef: "a".repeat(40),
      headSha: "b".repeat(40),
    };
    const r = await new TestCommandVerifier().verify({
      ...binding,
      testCommand: ["true"],
      signal: signal(),
    });
    expect(r.binding).toEqual(binding);
  });
});
