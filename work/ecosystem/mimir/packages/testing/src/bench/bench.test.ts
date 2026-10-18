import { describe, expect, it } from "vitest";
import {
  describeMachine,
  evaluate,
  formatMachine,
  formatTable,
  heapUsedBytes,
  meets,
  percentile,
  summarize,
  type BenchResult,
} from "./index.js";

describe("percentile (nearest rank)", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);

  it("returns the nearest-rank value", () => {
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(sorted, 0)).toBe(1);
  });

  it("is NaN for no samples and rejects p outside 0..100", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile(sorted, 101)).toThrow();
    expect(() => percentile(sorted, -1)).toThrow();
  });
});

describe("summarize", () => {
  it("sorts a copy and reports count, min, mean, p50/p95/p99, max", () => {
    const samples = [5, 1, 4, 2, 3];
    const s = summarize(samples);
    expect(s).toEqual({ count: 5, min: 1, mean: 3, p50: 3, p95: 5, p99: 5, max: 5 });
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it("reports NaN statistics for no samples", () => {
    const s = summarize([]);
    expect(s.count).toBe(0);
    expect(s.p95).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe("thresholds", () => {
  it("meets applies each comparator", () => {
    expect(meets(1, { op: "<", value: 2, source: "roadmap" })).toBe(true);
    expect(meets(2, { op: "<", value: 2, source: "roadmap" })).toBe(false);
    expect(meets(2, { op: "<=", value: 2, source: "guard" })).toBe(true);
    expect(meets(3, { op: ">", value: 2, source: "guard" })).toBe(true);
    expect(meets(2, { op: ">=", value: 2, source: "guard" })).toBe(true);
    expect(meets(0, { op: "==", value: 0, source: "guard" })).toBe(true);
    expect(meets(1, { op: "==", value: 0, source: "guard" })).toBe(false);
  });

  it("never passes NaN", () => {
    expect(meets(NaN, { op: "<", value: 2, source: "guard" })).toBe(false);
  });

  it("evaluate splits results into passed, failed and unchecked", () => {
    const results: BenchResult[] = [
      {
        scenario: "a",
        metric: "p95",
        value: 10,
        unit: "ms",
        threshold: { op: "<", value: 1000, source: "roadmap" },
      },
      {
        scenario: "a",
        metric: "drops",
        value: 2,
        unit: "count",
        threshold: { op: "==", value: 0, source: "roadmap" },
      },
      { scenario: "b", metric: "p50", value: 3, unit: "ms" },
    ];
    const r = evaluate(results);
    expect(r.passed.map((x) => x.metric)).toEqual(["p95"]);
    expect(r.failed.map((x) => x.metric)).toEqual(["drops"]);
    expect(r.unchecked.map((x) => x.metric)).toEqual(["p50"]);
    expect(r.ok).toBe(false);
    expect(evaluate([results[0] as BenchResult]).ok).toBe(true);
  });
});

describe("formatTable", () => {
  it("renders a markdown table with target and status columns", () => {
    const table = formatTable([
      {
        scenario: "sse",
        metric: "e2e p95",
        value: 12.3456,
        unit: "ms",
        threshold: { op: "<", value: 1000, source: "roadmap" },
      },
      {
        scenario: "sse",
        metric: "drops",
        value: 1,
        unit: "count",
        threshold: { op: "==", value: 0, source: "guard" },
      },
      { scenario: "store", metric: "reads", value: 123456.7, unit: "events/s", note: "limit 500" },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toBe("| Scenario | Metric | Value | Target | Status |");
    expect(lines[1]).toBe("|---|---|---|---|---|");
    expect(lines[2]).toBe("| sse | e2e p95 | 12.35 ms | < 1000 (roadmap) | PASS |");
    expect(lines[3]).toBe("| sse | drops | 1 count | == 0 (guard) | FAIL |");
    expect(lines[4]).toBe("| store | reads (limit 500) | 123456.7 events/s | - | - |");
  });
});

describe("machine description", () => {
  it("describes cpu, memory, load and node", () => {
    const m = describeMachine();
    expect(m.cpu.length).toBeGreaterThan(0);
    expect(m.cores).toBeGreaterThan(0);
    expect(m.memoryGb).toBeGreaterThan(0);
    expect(m.loadAvg).toHaveLength(3);
    expect(m.node).toBe(process.version);
    const text = formatMachine(m);
    expect(text).toContain(m.cpu);
    expect(text).toContain("load average");
  });

  it("heapUsedBytes is a positive number", () => {
    expect(heapUsedBytes()).toBeGreaterThan(0);
  });
});
