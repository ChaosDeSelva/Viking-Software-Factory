/** Benchmark results, threshold assertions and the report table. */
export type Comparator = "<" | "<=" | ">" | ">=" | "==";

export interface Threshold {
  op: Comparator;
  value: number;
  /** `roadmap`: a nonfunctional target from the roadmap. `guard`: a regression guard. */
  source: "roadmap" | "guard";
}

export interface BenchResult {
  scenario: string;
  metric: string;
  value: number;
  unit: string;
  threshold?: Threshold;
  note?: string;
}

export function meets(value: number, t: Threshold): boolean {
  if (Number.isNaN(value)) return false;
  switch (t.op) {
    case "<":
      return value < t.value;
    case "<=":
      return value <= t.value;
    case ">":
      return value > t.value;
    case ">=":
      return value >= t.value;
    case "==":
      return value === t.value;
  }
}

export interface Evaluation {
  ok: boolean;
  passed: BenchResult[];
  failed: BenchResult[];
  unchecked: BenchResult[];
}

export function evaluate(results: readonly BenchResult[]): Evaluation {
  const out: Evaluation = { ok: true, passed: [], failed: [], unchecked: [] };
  for (const r of results) {
    if (r.threshold === undefined) out.unchecked.push(r);
    else if (meets(r.value, r.threshold)) out.passed.push(r);
    else out.failed.push(r);
  }
  out.ok = out.failed.length === 0;
  return out;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** Markdown table: Scenario | Metric | Value | Target | Status. */
export function formatTable(results: readonly BenchResult[]): string {
  const lines = ["| Scenario | Metric | Value | Target | Status |", "|---|---|---|---|---|"];
  for (const r of results) {
    const metric = r.note === undefined ? r.metric : `${r.metric} (${r.note})`;
    const target =
      r.threshold === undefined
        ? "-"
        : `${r.threshold.op} ${formatNumber(r.threshold.value)} (${r.threshold.source})`;
    const status = r.threshold === undefined ? "-" : meets(r.value, r.threshold) ? "PASS" : "FAIL";
    lines.push(
      `| ${r.scenario} | ${metric} | ${formatNumber(r.value)} ${r.unit} | ${target} | ${status} |`,
    );
  }
  return lines.join("\n");
}
