// pnpm test:coverage: every workspace package's Vitest suite with V8 coverage.
//
// Each package runs with its own vitest config and working directory, exactly as `pnpm test`
// runs it, plus coverage flags. Reports land in coverage/<package>/ (text, lcov, json-summary);
// coverage/<dir>.vitest.log keeps each run's output; coverage/lcov.info merges every package and coverage/coverage-summary.json holds the totals.
// Core packages must stay at or above the floors in scripts/coverage-thresholds.json.
//
// Flags: --only <dir>[,<dir>] restricts the run (e.g. --only packages/core).
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkThresholds, formatCoverageTable, mergeLcov, totalsOf } from "./coverage-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "coverage");
const thresholds = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(join(root, "scripts/coverage-thresholds.json"), "utf8")),
  ).filter(([k]) => !k.startsWith("$")),
);

const PACKAGES = [
  "packages/core",
  "packages/protocol",
  "packages/herdr-adapter",
  "packages/git",
  "packages/fake-runtime",
  "packages/sdk",
  "packages/telemetry",
  "packages/testing",
  "apps/server",
  "apps/cli",
  "apps/web",
];
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg === -1 ? null : (process.argv[onlyArg + 1] ?? "").split(",");
const selected = only ? PACKAGES.filter((p) => only.includes(p)) : PACKAGES;

// Generated code, tests, fixtures, test support and type-only declaration files are not measured.
// Process entry points (main.ts) are exercised by the release, chaos and QA smoke suites instead.
const EXCLUDE = [
  "**/*.test.{ts,tsx}",
  "**/*.d.ts",
  "**/test/**",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/test-helpers.ts",
  "**/test-harness.ts",
  "**/test-setup.ts",
  "src/main.ts",
  "src/main.tsx",
];

const CONCURRENCY = Number(process.env["MIMIR_COVERAGE_CONCURRENCY"] ?? 4);

function runPackage(pkg) {
  const dir = join(root, pkg);
  const reports = join(out, pkg);
  mkdirSync(reports, { recursive: true });
  const args = [
    "exec",
    "vitest",
    "run",
    "--coverage.enabled",
    "--coverage.provider=v8",
    `--coverage.reportsDirectory=${reports}`,
    "--coverage.reporter=text",
    "--coverage.reporter=lcov",
    "--coverage.reporter=json-summary",
    "--coverage.reportOnFailure",
    "--coverage.include=src/**/*.{ts,tsx}",
    ...EXCLUDE.map((e) => `--coverage.exclude=${e}`),
  ];
  // Outside the reports dir: Vitest cleans that dir when coverage starts.
  const log = join(out, `${pkg.replace("/", "-")}.vitest.log`);
  const stream = createWriteStream(log);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("pnpm", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    child.on("close", (code) => {
      stream.end();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${code === 0 ? "ok  " : "FAIL"} ${pkg} (${secs}s) log: ${log}`);
      resolve({ pkg, code, log, reports });
    });
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const queue = [...selected];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) results.push(await runPackage(pkg));
  }),
);
results.sort((a, b) => selected.indexOf(a.pkg) - selected.indexOf(b.pkg));

const measured = {};
const lcovParts = [];
for (const r of results) {
  const summaryFile = join(r.reports, "coverage-summary.json");
  if (existsSync(summaryFile)) {
    measured[r.pkg] = totalsOf(JSON.parse(readFileSync(summaryFile, "utf8")));
  }
  const lcov = join(r.reports, "lcov.info");
  if (existsSync(lcov))
    lcovParts.push({ dir: join(root, r.pkg), text: readFileSync(lcov, "utf8") });
}
writeFileSync(join(out, "lcov.info"), mergeLcov(root, lcovParts));
writeFileSync(join(out, "coverage-summary.json"), JSON.stringify(measured, null, 2) + "\n");

const failedTests = results.filter((r) => r.code !== 0);
const relevantThresholds = only
  ? Object.fromEntries(Object.entries(thresholds).filter(([k]) => selected.includes(k)))
  : thresholds;
const problems = checkThresholds(measured, relevantThresholds);

console.log(`\n${formatCoverageTable(measured, thresholds)}\n`);
for (const r of failedTests) console.error(`tests failed in ${r.pkg}: see ${r.log}`);
for (const p of problems) console.error(`coverage below floor: ${p}`);
if (failedTests.length === 0 && problems.length === 0) {
  console.log(`coverage ok: ${results.length} packages, reports in ${out}`);
}
process.exit(failedTests.length === 0 && problems.length === 0 ? 0 : 1);
