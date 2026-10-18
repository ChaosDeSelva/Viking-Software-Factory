import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunner, formatTable } from "./steps.mjs";

const fresh = () => createRunner({ outDir: mkdtempSync(join(tmpdir(), "qa-steps-")) });

describe("step runner", () => {
  it("records pass, fail and skip with durations and an evidence file per step", async () => {
    const r = fresh();
    await r.step("ok", async (ctx) => {
      await ctx.exec("echo", process.execPath, ["-e", "console.log('hello')"]);
    });
    await r.step("boom", async (ctx) => {
      ctx.expect(1 === 2, "one is not two");
    });
    await r.step("later", async (ctx) => ctx.skip("no mimir build"));
    const [ok, boom, later] = r.results;
    expect([ok.status, boom.status, later.status]).toEqual(["pass", "fail", "skip"]);
    expect(boom.detail).toContain("one is not two");
    expect(later.detail).toBe("no mimir build");
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(ok.file, "utf8")).toContain("hello");
    expect(readFileSync(boom.file, "utf8")).toContain("one is not two");
    expect(r.exitCode()).toBe(1);
  });

  it("exits 0 only when nothing failed (skips are visible but allowed)", async () => {
    const r = fresh();
    await r.step("a", async () => {});
    await r.step("b", async (ctx) => ctx.skip("why"));
    expect(r.exitCode()).toBe(0);
  });

  it("exec fails the step on an unexpected exit code, and honours expected codes", async () => {
    const r = fresh();
    await r.step("expected-1", async (ctx) => {
      const res = await ctx.exec("exit1", process.execPath, ["-e", "process.exit(1)"], {
        expect: [1],
      });
      expect(res.code).toBe(1);
    });
    await r.step("unexpected", async (ctx) => {
      await ctx.exec("exit2", process.execPath, ["-e", "process.exit(2)"]);
    });
    expect(r.results.map((x) => x.status)).toEqual(["pass", "fail"]);
    expect(r.results[1].detail).toMatch(/exit 2/);
  });

  it("a thrown error after a failing step does not stop later steps", async () => {
    const r = fresh();
    await r.step("x", async () => {
      throw new Error("kaput");
    });
    await r.step("y", async () => {});
    expect(r.results.map((x) => x.status)).toEqual(["fail", "pass"]);
  });
});

describe("formatTable", () => {
  it("prints step, result, duration and evidence path, one row per step", () => {
    const t = formatTable([
      { name: "doctor", status: "pass", durationMs: 1234, file: "/o/01-doctor.log", detail: "" },
      {
        name: "verify",
        status: "fail",
        durationMs: 50,
        file: "/o/02-verify.log",
        detail: "exit 2",
      },
    ]);
    const lines = t.split("\n");
    expect(lines[0]).toMatch(/step\s+result\s+duration\s+evidence/);
    expect(t).toMatch(/doctor\s+PASS\s+1\.2s\s+\/o\/01-doctor\.log/);
    expect(t).toMatch(/verify\s+FAIL\s+0\.1s\s+\/o\/02-verify\.log/);
    expect(t).toContain("exit 2");
    expect(t).toMatch(/1 passed, 1 failed, 0 skipped/);
  });
});
