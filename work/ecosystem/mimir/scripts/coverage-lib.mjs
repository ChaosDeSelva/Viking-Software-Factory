// Helpers for scripts/coverage.mjs (pnpm test:coverage). Node built-ins only.
import { isAbsolute, join, relative } from "node:path";

export const METRICS = ["statements", "branches", "functions", "lines"];

/** The four total percentages of a Vitest/istanbul `coverage-summary.json`. */
export function totalsOf(summary) {
  return Object.fromEntries(METRICS.map((m) => [m, summary.total[m].pct]));
}

/** Messages for every metric below its floor; a core package with no measurement also fails. */
export function checkThresholds(measured, thresholds) {
  const problems = [];
  for (const [pkg, floor] of Object.entries(thresholds)) {
    const got = measured[pkg];
    if (!got) {
      problems.push(`${pkg}: no coverage measured`);
      continue;
    }
    for (const m of METRICS) {
      if (got[m] < floor[m]) problems.push(`${pkg} ${m} ${got[m]}% < ${floor[m]}%`);
    }
  }
  return problems;
}

/** package | stmts | branches | funcs | lines | floor (s/b/f/l) */
export function formatCoverageTable(measured, thresholds) {
  const header = ["package", "stmts", "branches", "funcs", "lines", "floor (s/b/f/l)"];
  const rows = Object.entries(measured).map(([pkg, t]) => [
    pkg,
    ...METRICS.map((m) => t[m].toFixed(2)),
    thresholds[pkg] ? METRICS.map((m) => thresholds[pkg][m]).join("/") : "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) =>
    r
      .map((v, i) => (i === r.length - 1 ? v : v.padEnd(widths[i])))
      .join(" | ")
      .trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  return [line(header), sep, ...rows.map(line)].join("\n");
}

/** Concatenates per-package lcov reports with `SF:` paths relative to the repo root. */
export function mergeLcov(root, parts) {
  return parts
    .map(({ dir, text }) =>
      text.replace(/^SF:(.*)$/gm, (_, p) => {
        const abs = isAbsolute(p) ? p : join(dir, p);
        return `SF:${relative(root, abs)}`;
      }),
    )
    .join("");
}
