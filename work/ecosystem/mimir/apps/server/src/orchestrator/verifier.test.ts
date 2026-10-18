import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CHECK_OUTPUT, TestCommandVerifier } from "./verifier.js";

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
    expect(r.checks[0]!.output).toContain("[truncated]");
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
