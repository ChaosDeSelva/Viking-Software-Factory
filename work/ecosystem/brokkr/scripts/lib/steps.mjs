// Step runner and table for scripts/qa-smoke.mjs. Every step logs to <outDir>/NN-<name>.log;
// a failed or throwing step is recorded and the run continues; exitCode() is 0 only if no step failed.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

class Skip extends Error {}

export function createRunner({ outDir, env = process.env }) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  let n = 0;
  return {
    results,
    outDir,
    async step(name, fn) {
      n += 1;
      const file = join(
        outDir,
        `${String(n).padStart(2, "0")}-${name.replace(/[^\w.-]+/g, "_")}.log`,
      );
      writeFileSync(file, `# step: ${name}\n`);
      const started = Date.now();
      const ctx = {
        file,
        log: (text) => appendFileSync(file, `${text}\n`),
        expect(cond, msg) {
          if (!cond) throw new Error(msg);
        },
        skip(reason) {
          throw new Skip(reason);
        },
        exec(label, cmd, args, opts = {}) {
          const expected = opts.expect ?? [0];
          ctx.log(`\n$ ${[cmd, ...args].join(" ")}   (${label}, cwd ${opts.cwd ?? process.cwd()})`);
          return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, {
              cwd: opts.cwd,
              env: opts.env ?? env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20 * 60_000);
            child.stdout.on("data", (d) => {
              stdout += d;
              appendFileSync(file, d);
            });
            child.stderr.on("data", (d) => {
              stderr += d;
              appendFileSync(file, d);
            });
            child.on("error", (e) => {
              clearTimeout(timer);
              reject(e);
            });
            child.on("close", (code, signal) => {
              clearTimeout(timer);
              const c = code ?? 1;
              ctx.log(`[exit ${c}${signal ? ` signal ${signal}` : ""}]`);
              if (!expected.includes(c))
                reject(new Error(`${label}: exit ${c}, expected ${expected.join("|")}`));
              else resolve({ code: c, stdout, stderr });
            });
          });
        },
      };
      let status = "pass";
      let detail = "";
      try {
        await fn(ctx);
      } catch (e) {
        if (e instanceof Skip) {
          status = "skip";
          detail = e.message;
        } else {
          status = "fail";
          detail = e instanceof Error ? e.message : String(e);
          ctx.log(`FAILED: ${detail}`);
        }
      }
      results.push({ name, status, durationMs: Date.now() - started, file, detail });
      console.log(`${status.toUpperCase().padEnd(5)} ${name}${detail ? `  (${detail})` : ""}`);
    },
    exitCode: () => (results.some((r) => r.status === "fail") ? 1 : 0),
  };
}

export function formatTable(results) {
  const w = Math.max(4, ...results.map((r) => r.name.length));
  const row = (a, b, c, d) => `${a.padEnd(w)}  ${b.padEnd(6)}  ${c.padEnd(8)}  ${d}`;
  const lines = [row("step", "result", "duration", "evidence")];
  for (const r of results) {
    lines.push(
      row(r.name, r.status.toUpperCase(), `${(r.durationMs / 1000).toFixed(1)}s`, r.file) +
        (r.detail ? `\n${" ".repeat(w + 2)}-> ${r.detail}` : ""),
    );
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push(`\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`);
  return lines.join("\n");
}
