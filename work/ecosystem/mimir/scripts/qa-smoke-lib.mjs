// Step runner for scripts/qa-smoke.mjs: runs named steps, captures each step's command output
// in a numbered evidence file, and prints a step table. Node built-ins only.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const formatDuration = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Runs a command, appending the command line, stdout, stderr and exit code to `logFile`.
 * Rejects on a non-zero exit (unless `allowFail`) or after `timeoutMs` (the child is killed).
 */
export function execLogged(logFile, cmd, args, opts = {}) {
  const { allowFail = false, timeoutMs = 10 * 60_000, input, ...spawnOpts } = opts;
  appendFileSync(logFile, `$ ${[cmd, ...args].join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (b) => {
      stdout += b;
      appendFileSync(logFile, b);
    });
    child.stderr.on("data", (b) => {
      stderr += b;
      appendFileSync(logFile, b);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      appendFileSync(logFile, `spawn error: ${err.message}\n`);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      appendFileSync(logFile, `exit ${code ?? signal}\n\n`);
      if (timedOut) reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      else if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} ${args.slice(0, 2).join(" ")} exited ${code ?? signal}`));
      } else resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * `step(name, fn, { requires })`: runs `fn(ctx)` and records PASS / FAIL (it threw) / SKIP (a
 * required step did not pass). `ctx.exec` runs a logged command, `ctx.note` appends a line,
 * `ctx.evidence` is the step's log file. `ok` is true only when every step passed.
 */
export function createRunner({ outDir, log = (s) => process.stdout.write(s + "\n") }) {
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  let n = 0;
  const evidencePath = (name) => join(outDir, `${String(++n).padStart(2, "0")}-${slug(name)}.log`);

  async function step(name, fn, { requires = [] } = {}) {
    const evidence = evidencePath(name);
    const missing = requires.filter((r) => !rows.some((x) => x.step === r && x.result === "PASS"));
    if (missing.length > 0) {
      const detail = `requires: ${missing.join(", ")}`;
      writeFileSync(evidence, `SKIP ${detail}\n`);
      rows.push({ step: name, result: "SKIP", durationMs: 0, evidence, detail });
      log(`SKIP ${name} (${detail})`);
      return undefined;
    }
    writeFileSync(evidence, `# ${name}\n`);
    const ctx = {
      evidence,
      exec: (cmd, args, opts) => execLogged(evidence, cmd, args, opts),
      note: (text) => appendFileSync(evidence, `${text}\n`),
    };
    log(`...  ${name}`);
    const started = Date.now();
    try {
      const value = await fn(ctx);
      const durationMs = Date.now() - started;
      appendFileSync(evidence, `PASS (${formatDuration(durationMs)})\n`);
      rows.push({ step: name, result: "PASS", durationMs, evidence });
      log(`PASS ${name} (${formatDuration(durationMs)})`);
      return value;
    } catch (err) {
      const durationMs = Date.now() - started;
      const detail = err instanceof Error ? err.message : String(err);
      appendFileSync(evidence, `FAIL: ${err instanceof Error ? err.stack : detail}\n`);
      rows.push({ step: name, result: "FAIL", durationMs, evidence, detail });
      log(`FAIL ${name}: ${detail}`);
      return undefined;
    }
  }

  return {
    rows,
    step,
    evidencePath,
    get ok() {
      return rows.length > 0 && rows.every((r) => r.result === "PASS");
    },
  };
}

/** The step table: step | result | duration | evidence (relative to `baseDir`), then failure reasons. */
export function formatTable(rows, { baseDir }) {
  const cells = rows.map((r) => [
    r.step,
    r.result,
    formatDuration(r.durationMs),
    relative(baseDir, r.evidence),
  ]);
  const header = ["step", "result", "duration", "evidence"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) =>
    c
      .map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i])))
      .join(" | ")
      .trimEnd();
  const sep = widths
    .map((w, i) => "-".repeat(i === 0 ? w + 1 : i === widths.length - 1 ? w + 1 : w + 2))
    .join("|");
  const reasons = rows
    .filter((r) => r.result !== "PASS")
    .map((r) => `${r.result} ${r.step}: ${r.detail ?? ""}`);
  return [line(header), sep, ...cells.map(line), ...(reasons.length ? ["", ...reasons] : [])].join(
    "\n",
  );
}
