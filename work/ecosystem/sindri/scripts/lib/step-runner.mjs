// Step runner for scripts/qa-smoke.mjs: runs named steps in order, captures each step's log in
// <outDir>/NN-<slug>.log, and records PASS / FAIL / SKIP with duration for the final table.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

class Skip extends Error {}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * @param {{ outDir: string, now?: () => number, echo?: (line: string) => void }} opts
 * step(name, fn, { required }) runs fn(log, ctl); ctl.skip(reason) ends it as SKIP and
 * ctl.note(text) annotates it. After a failed `required` step, the rest are skipped.
 */
export function createRunner({ outDir, now = () => performance.now(), echo = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  let blocked;

  async function step(name, fn, { required = false } = {}) {
    const n = results.length + 1;
    const evidence = join(outDir, `${String(n).padStart(2, "0")}-${slug(name)}.log`);
    writeFileSync(evidence, "");
    const log = (line) => appendFileSync(evidence, `${line}\n`);
    const record = (result, ms, note) => {
      results.push({ n, name, result, ms, evidence, note });
      echo(`[${result}] ${n}. ${name}${note ? ` (${note})` : ""}`);
    };
    if (blocked) {
      const note = `blocked by failed step ${blocked.n} (${blocked.name})`;
      log(note);
      record("SKIP", 0, note);
      return undefined;
    }
    let note = "";
    const ctl = {
      skip: (reason) => {
        throw new Skip(reason);
      },
      note: (text) => {
        note = text;
      },
    };
    const start = now();
    try {
      const value = await fn(log, ctl);
      record("PASS", Math.round(now() - start), note);
      return value;
    } catch (err) {
      const ms = Math.round(now() - start);
      if (err instanceof Skip) {
        log(`SKIP: ${err.message}`);
        record("SKIP", ms, err.message);
        return undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`FAIL: ${err instanceof Error && err.stack ? err.stack : message}`);
      record("FAIL", ms, message.split("\n")[0] ?? "");
      if (required) blocked = { n, name };
      return undefined;
    }
  }

  return { step, results, ok: () => results.every((r) => r.result !== "FAIL") };
}

/** Aligned table: #, step, result, duration (s, one decimal), evidence, note; then totals. */
export function formatStepTable(results) {
  const header = ["#", "step", "result", "duration", "evidence", "note"];
  const rows = results.map((r) => [
    String(r.n),
    r.name,
    r.result,
    `${(r.ms / 1000).toFixed(1)}s`,
    r.evidence,
    r.note,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + 2)))
      .join("")
      .trimEnd();
  const count = (k) => results.filter((r) => r.result === k).length;
  return [
    fmt(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(fmt),
    `total ${results.length}: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`,
  ].join("\n");
}
