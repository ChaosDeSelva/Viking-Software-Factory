// Builds the vitest CLI flags for one package's coverage run from scripts/coverage-config.json.
export const METRICS = ["statements", "branches", "functions", "lines"];

export function coverageArgs(pkgDir, entry, defaults, outRoot) {
  const exclude = [...defaults.exclude, ...(entry.exclude ?? [])];
  const args = [
    "vitest",
    "run",
    "--coverage",
    "--coverage.provider=v8",
    "--coverage.reporter=text",
    "--coverage.reporter=lcov",
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${outRoot}/${pkgDir.replaceAll("/", "-")}`,
    "--coverage.include=src/**/*.ts",
    "--coverage.reportOnFailure=true",
    ...exclude.map((e) => `--coverage.exclude=${e}`),
  ];
  if (entry.thresholds)
    for (const m of METRICS) args.push(`--coverage.thresholds.${m}=${entry.thresholds[m]}`);
  return args;
}

// measured -> enforced threshold: minus 2 points, floored, never negative.
export function thresholdFor(measured) {
  return Math.max(0, Math.floor(measured - 2));
}
