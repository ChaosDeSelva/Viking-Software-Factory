// pnpm test:coverage: runs every package's tests with v8 coverage (text + lcov + json-summary
// under coverage/<package>/), enforces scripts/coverage-config.json thresholds on the core
// packages, and prints one summary table. Exits non-zero if any package fails tests or thresholds.
// Needs a built workspace (pnpm build); packages are run one after another because several
// suites spawn real processes and are timing sensitive.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageArgs } from "./lib/coverage-args.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "scripts/coverage-config.json"), "utf8"));
const outRoot = join(root, "coverage");
const only = process.argv.slice(2);
const rows = [];
let failed = false;

for (const [dir, entry] of Object.entries(config.packages)) {
  if (only.length && !only.some((o) => dir.endsWith(o))) continue;
  console.log(`\n=== coverage: ${dir}`);
  const r = spawnSync("pnpm", ["exec", ...coverageArgs(dir, entry, config, outRoot)], {
    cwd: join(root, dir),
    stdio: "inherit",
  });
  const summary = join(outRoot, dir.replaceAll("/", "-"), "coverage-summary.json");
  const total = existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")).total : undefined;
  const pct = (m) => (total ? `${total[m].pct}` : "n/a");
  rows.push({
    pkg: dir,
    statements: pct("statements"),
    branches: pct("branches"),
    functions: pct("functions"),
    lines: pct("lines"),
    gate: entry.thresholds ? "enforced" : "report only",
    exit: r.status ?? 1,
  });
  if (r.status !== 0) failed = true;
}

console.log("\npackage                stmts   branch  funcs   lines   gate         exit");
for (const r of rows)
  console.log(
    `${r.pkg.padEnd(22)} ${r.statements.padEnd(7)} ${r.branches.padEnd(7)} ${r.functions.padEnd(7)} ${r.lines.padEnd(7)} ${r.gate.padEnd(12)} ${r.exit}`,
  );
process.exit(failed ? 1 : 0);
