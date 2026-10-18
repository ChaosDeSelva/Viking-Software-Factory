/**
 * Mimir performance and load benchmarks.
 *
 *   pnpm bench        report mode: prints the machine and a results table
 *   pnpm bench:check  CI mode: same, then exits 1 if any threshold is missed
 *
 * Flags: --check, --scale=<0..1> (shrink counts/durations), --only=<name,...>, --json=<path>.
 */
import { writeFileSync } from "node:fs";
import {
  describeMachine,
  evaluate,
  formatMachine,
  formatTable,
  type BenchResult,
} from "@mimir/testing";
import { SCENARIOS } from "./scenarios/index.js";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const check = process.argv.includes("--check");
const scale = Number(flag("scale") ?? "1");
if (!(scale > 0 && scale <= 1)) throw new Error(`--scale must be in (0, 1], got ${scale}`);
const only = flag("only")?.split(",");
const selected = SCENARIOS.filter((s) => only === undefined || only.includes(s.name));
if (selected.length === 0) throw new Error(`no scenario matches --only=${only?.join(",")}`);

const before = describeMachine();
console.log(`mimir bench (${check ? "check" : "report"} mode, scale ${scale})`);
console.log(formatMachine(before));
if ((globalThis as { gc?: unknown }).gc === undefined) {
  console.log("warning: run with --expose-gc for stable heap measurements");
}

const results: BenchResult[] = [];
for (const s of selected) {
  console.log(`\n> ${s.name}: ${s.description}`);
  const t0 = performance.now();
  results.push(...(await s.run({ scale, log: (l) => console.log(l) })));
  console.log(`  done in ${Math.round(performance.now() - t0)} ms`);
}

const after = describeMachine();
console.log(`\nload average after run: ${after.loadAvg.join(" ")}\n`);
console.log(formatTable(results));
const verdict = evaluate(results);
console.log(
  `\nthresholds: ${verdict.passed.length} passed, ${verdict.failed.length} failed, ` +
    `${verdict.unchecked.length} informational`,
);
for (const f of verdict.failed) {
  console.log(`  MISSED: ${f.scenario} / ${f.metric} = ${f.value} ${f.unit}`);
}
const json = flag("json");
if (json !== undefined) {
  writeFileSync(json, JSON.stringify({ machine: before, after, scale, results }, null, 2));
}
if (check && !verdict.ok) process.exitCode = 1;
