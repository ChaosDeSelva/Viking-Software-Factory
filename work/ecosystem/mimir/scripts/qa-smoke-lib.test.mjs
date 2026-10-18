import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunner, formatDuration, formatTable, slug } from "./qa-smoke-lib.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "qa-smoke-lib-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("slug", () => {
  it("makes a file-safe step name", () => {
    expect(slug("mimir doctor")).toBe("mimir-doctor");
    expect(slug("GET /v1/events replay (cursor)")).toBe("get-v1-events-replay-cursor");
  });
});

describe("formatDuration", () => {
  it("prints milliseconds under a second and seconds with one decimal above", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(61_000)).toBe("61.0s");
  });
});

describe("createRunner", () => {
  it("records a passing step and writes exec output to its numbered evidence file", async () => {
    const out = tmp();
    const r = createRunner({ outDir: out, log: () => {} });
    const value = await r.step("echo hello", async (ctx) => {
      const res = await ctx.exec("node", ["-e", "console.log('hi'); console.error('warn')"]);
      expect(res.stdout).toBe("hi\n");
      ctx.note("checked hi");
      return 7;
    });
    expect(value).toBe(7);
    expect(r.rows).toEqual([
      expect.objectContaining({
        step: "echo hello",
        result: "PASS",
        evidence: join(out, "01-echo-hello.log"),
      }),
    ]);
    const log = readFileSync(join(out, "01-echo-hello.log"), "utf8");
    expect(log).toContain("$ node -e");
    expect(log).toContain("hi");
    expect(log).toContain("warn");
    expect(log).toContain("exit 0");
    expect(log).toContain("checked hi");
    expect(r.ok).toBe(true);
  });

  it("marks a throwing step FAIL, logs the error, and keeps running later steps", async () => {
    const out = tmp();
    const r = createRunner({ outDir: out, log: () => {} });
    const v = await r.step("boom", async () => {
      throw new Error("expected 3 tasks, saw 2");
    });
    expect(v).toBeUndefined();
    await r.step("after", async () => {});
    expect(r.rows.map((x) => [x.step, x.result])).toEqual([
      ["boom", "FAIL"],
      ["after", "PASS"],
    ]);
    expect(r.rows[0].detail).toBe("expected 3 tasks, saw 2");
    expect(readFileSync(r.rows[0].evidence, "utf8")).toContain("expected 3 tasks, saw 2");
    expect(r.ok).toBe(false);
  });

  it("fails a step whose command exits non-zero, keeping its output as evidence", async () => {
    const out = tmp();
    const r = createRunner({ outDir: out, log: () => {} });
    await r.step("bad exit", async (ctx) => {
      await ctx.exec("node", ["-e", "console.log('partial'); process.exit(4)"]);
    });
    expect(r.rows[0]).toMatchObject({ result: "FAIL" });
    expect(r.rows[0].detail).toMatch(/exited 4/);
    const log = readFileSync(r.rows[0].evidence, "utf8");
    expect(log).toContain("partial");
    expect(log).toContain("exit 4");
  });

  it("allowFail returns the exit code instead of failing", async () => {
    const r = createRunner({ outDir: tmp(), log: () => {} });
    await r.step("tolerant", async (ctx) => {
      const res = await ctx.exec("node", ["-e", "process.exit(3)"], { allowFail: true });
      expect(res.code).toBe(3);
    });
    expect(r.rows[0].result).toBe("PASS");
  });

  it("kills a command that exceeds its timeout and fails the step", async () => {
    const r = createRunner({ outDir: tmp(), log: () => {} });
    await r.step("slow", async (ctx) => {
      await ctx.exec("node", ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 200 });
    });
    expect(r.rows[0]).toMatchObject({ result: "FAIL" });
    expect(r.rows[0].detail).toMatch(/timed out after 200ms/);
  });

  it("skips a step whose requirement did not pass, and a skip is not ok", async () => {
    const r = createRunner({ outDir: tmp(), log: () => {} });
    await r.step("build", async () => {
      throw new Error("no");
    });
    let ran = false;
    await r.step(
      "install",
      async () => {
        ran = true;
      },
      { requires: ["build"] },
    );
    expect(ran).toBe(false);
    expect(r.rows[1]).toMatchObject({ result: "SKIP", detail: "requires: build" });
    expect(r.ok).toBe(false);
  });

  it("evidencePath reserves a numbered file for a long-lived process", () => {
    const out = tmp();
    const r = createRunner({ outDir: out, log: () => {} });
    expect(r.evidencePath("server run 1")).toBe(join(out, "01-server-run-1.log"));
    expect(r.evidencePath("server run 2")).toBe(join(out, "02-server-run-2.log"));
  });
});

describe("formatTable", () => {
  it("prints aligned columns with evidence relative to the output dir", () => {
    const rows = [
      { step: "mimir doctor", result: "PASS", durationMs: 812, evidence: "/o/01-mimir-doctor.log" },
      {
        step: "events replay",
        result: "FAIL",
        durationMs: 2500,
        evidence: "/o/02-events-replay.log",
        detail: "gap",
      },
    ];
    const text = formatTable(rows, { baseDir: "/o" });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^step\s+\| result \| duration \| evidence$/);
    expect(lines[1]).toMatch(/^-+\|-+\|-+\|-+$/);
    expect(lines[2]).toMatch(/^mimir doctor\s+\| PASS\s+\| 812ms\s+\| 01-mimir-doctor\.log$/);
    expect(lines[3]).toMatch(/^events replay\s+\| FAIL\s+\| 2\.5s\s+\| 02-events-replay\.log$/);
    // every row has the same column positions
    expect(new Set(lines.slice(0, 4).map((l) => l.indexOf("|"))).size).toBe(1);
    expect(text).toContain("FAIL events replay: gap");
  });
});
