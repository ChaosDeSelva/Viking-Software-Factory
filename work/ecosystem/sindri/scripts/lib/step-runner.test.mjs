// Unit tests for the qa:smoke step runner: result bookkeeping, evidence files and the table.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunner, formatStepTable } from "./step-runner.mjs";

const dirs = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), "qa-runner-"));
  dirs.push(d);
  return d;
};

describe("createRunner", () => {
  it("records a passing step with duration and writes its log to an evidence file", async () => {
    const dir = outDir();
    const r = createRunner({
      outDir: dir,
      now: (() => {
        let t = 0;
        return () => (t += 250);
      })(),
    });
    const value = await r.step("doctor", async (log) => {
      log("hello");
      log("world");
      return 42;
    });
    expect(value).toBe(42);
    expect(r.results).toEqual([
      {
        n: 1,
        name: "doctor",
        result: "PASS",
        ms: 250,
        evidence: join(dir, "01-doctor.log"),
        note: "",
      },
    ]);
    expect(readFileSync(join(dir, "01-doctor.log"), "utf8")).toBe("hello\nworld\n");
    expect(r.ok()).toBe(true);
  });

  it("records a failing step, keeps the error in the evidence file, and later steps still run", async () => {
    const dir = outDir();
    const r = createRunner({ outDir: dir });
    const v = await r.step("boom step", async (log) => {
      log("before");
      throw new Error("expected 3 rows, got 0");
    });
    expect(v).toBeUndefined();
    await r.step("after", async () => {});
    expect(r.results.map((s) => s.result)).toEqual(["FAIL", "PASS"]);
    expect(r.results[0]?.note).toBe("expected 3 rows, got 0");
    expect(r.results[0]?.evidence).toBe(join(dir, "01-boom-step.log"));
    const text = readFileSync(join(dir, "01-boom-step.log"), "utf8");
    expect(text).toContain("before\n");
    expect(text).toContain("expected 3 rows, got 0");
    expect(r.ok()).toBe(false);
  });

  it("supports skip-with-reason, which does not fail the run", async () => {
    const r = createRunner({ outDir: outDir() });
    await r.step("acceptance", async (_log, ctl) => ctl.skip("no Mimir build at ../mimir"));
    expect(r.results[0]?.result).toBe("SKIP");
    expect(r.results[0]?.note).toBe("no Mimir build at ../mimir");
    expect(r.ok()).toBe(true);
  });

  it("a note set by the step is reported on success", async () => {
    const r = createRunner({ outDir: outDir() });
    await r.step("approve", async (_log, ctl) => ctl.note("approval factor: bearer-only"));
    expect(r.results[0]).toMatchObject({ result: "PASS", note: "approval factor: bearer-only" });
  });

  it("dependent steps are skipped once a required step failed", async () => {
    const r = createRunner({ outDir: outDir() });
    await r.step(
      "start",
      async () => {
        throw new Error("no port");
      },
      { required: true },
    );
    let ran = false;
    await r.step("use server", async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(r.results[1]).toMatchObject({
      result: "SKIP",
      note: "blocked by failed step 1 (start)",
    });
    expect(r.ok()).toBe(false);
  });
});

describe("formatStepTable", () => {
  it("prints an aligned table of step, result, duration and evidence plus a totals line", () => {
    const table = formatStepTable([
      { n: 1, name: "doctor", result: "PASS", ms: 1234, evidence: "/o/01-doctor.log", note: "" },
      {
        n: 2,
        name: "acceptance",
        result: "SKIP",
        ms: 5,
        evidence: "/o/02-acceptance.log",
        note: "no mimir",
      },
      {
        n: 3,
        name: "purge",
        result: "FAIL",
        ms: 70,
        evidence: "/o/03-purge.log",
        note: "rows left",
      },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^#\s+step\s+result\s+duration\s+evidence\s+note$/);
    expect(lines[2]).toMatch(/^1\s+doctor\s+PASS\s+1\.2s\s+\/o\/01-doctor\.log\s*$/);
    expect(lines[3]).toMatch(
      /^2\s+acceptance\s+SKIP\s+0\.0s\s+\/o\/02-acceptance\.log\s+no mimir$/,
    );
    expect(lines.at(-1)).toBe("total 3: 1 passed, 1 failed, 1 skipped");
  });
});
