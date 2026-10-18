import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockExecutor } from "./testing.js";

const req = (checkId: string, logFile?: string) => ({
  checkId,
  command: ["pnpm", "test"],
  workspace: tmpdir(),
  env: {},
  timeoutMs: 1000,
  ...(logFile ? { logFile } : {}),
});

describe("MockExecutor (@brokkr/sdk/testing)", () => {
  it("returns scripted states per check id and records every call", async () => {
    const mock = new MockExecutor({ lint: "passed", unit: { state: "failed", exitCode: 3 } });
    const lint = await mock.execute(req("lint"));
    const unit = await mock.execute(req("unit"));
    expect(lint).toMatchObject({ checkId: "lint", state: "passed", exitCode: 0 });
    expect(unit).toMatchObject({ checkId: "unit", state: "failed", exitCode: 3 });
    expect(mock.calls.map((c) => c.checkId)).toEqual(["lint", "unit"]);
    expect(Date.parse(unit.completedAt)).toBeGreaterThanOrEqual(Date.parse(unit.startedAt));
  });

  it("an unscripted check errors unless a fallback is given (never a silent pass)", async () => {
    const strict = await new MockExecutor({}).execute(req("x"));
    expect(strict.state).toBe("errored");
    expect(strict.error).toMatch(/no scripted result for check 'x'/);
    const lax = await new MockExecutor({}, { fallback: "passed" }).execute(req("x"));
    expect(lax.state).toBe("passed");
  });

  it("writes scripted output to the log file and the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-exec-"));
    const log = join(dir, "logs", "unit.log");
    const r = await new MockExecutor({ unit: { state: "passed", output: "84 passed\n" } }).execute(
      req("unit", log),
    );
    expect(readFileSync(log, "utf8")).toBe("84 passed\n");
    expect(r.outputTail).toBe("84 passed\n");
    expect(r.outputBytes).toBe(10);
  });

  it("supports functions and honours cancellation", async () => {
    const mock = new MockExecutor({
      slow: { state: "passed", delayMs: 5_000 },
      fn: (request) => ({ state: request.checkId === "fn" ? "timed_out" : "passed" }),
    });
    expect((await mock.execute(req("fn"))).state).toBe("timed_out");
    const ac = new AbortController();
    const pending = mock.execute(req("slow"), ac.signal);
    ac.abort();
    expect(await pending).toMatchObject({ state: "cancelled", reason: "cancelled" });
    const pre = new AbortController();
    pre.abort();
    expect((await mock.execute(req("lint"), pre.signal)).state).toBe("cancelled");
  });
});
