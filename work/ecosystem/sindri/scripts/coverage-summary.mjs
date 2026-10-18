// Per-package coverage from Vitest's coverage/coverage-summary.json (json-summary reporter).
// `node scripts/coverage-summary.mjs` prints a table and writes coverage/packages.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = ["statements", "branches", "functions", "lines"];
const round2 = (n) => Math.round(n * 100) / 100;

/** `apps/<x>` or `packages/<x>` for a file under `root`, else undefined. */
export function packageOf(file, root) {
  const rel = relative(root, file).split(sep);
  if (rel[0] === ".." || rel.length < 3) return undefined;
  if (rel[0] !== "apps" && rel[0] !== "packages") return undefined;
  return `${rel[0]}/${rel[1]}`;
}

/** Sums per-file totals into per-package totals; pct is recomputed (100 when total is 0). */
export function summarizeByPackage(summary, root) {
  const out = {};
  for (const [file, data] of Object.entries(summary)) {
    if (file === "total") continue;
    const pkg = packageOf(file, root);
    if (!pkg) continue;
    const acc = (out[pkg] ??= {
      ...Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0, pct: 100 }])),
      files: 0,
    });
    acc.files += 1;
    for (const m of METRICS) {
      acc[m].total += data[m].total;
      acc[m].covered += data[m].covered;
    }
  }
  for (const acc of Object.values(out))
    for (const m of METRICS)
      acc[m].pct = acc[m].total === 0 ? 100 : round2((acc[m].covered / acc[m].total) * 100);
  return out;
}

/** Aligned text table, packages sorted by name. */
export function formatPackageTable(byPackage) {
  const header = ["package", "stmts", "branch", "funcs", "lines", "files"];
  const rows = Object.keys(byPackage)
    .sort()
    .map((pkg) => {
      const p = byPackage[pkg];
      return [pkg, ...METRICS.map((m) => p[m].pct.toFixed(2)), String(p.files)];
    });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 2)))
      .join("")
      .trimEnd();
  return [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const summary = JSON.parse(readFileSync(join(root, "coverage", "coverage-summary.json"), "utf8"));
  const byPackage = summarizeByPackage(summary, root);
  writeFileSync(join(root, "coverage", "packages.json"), `${JSON.stringify(byPackage, null, 2)}\n`);
  console.log(formatPackageTable(byPackage));
}
