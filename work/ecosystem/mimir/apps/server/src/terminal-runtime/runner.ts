import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
// Runs inside a native terminal; Mimir restarts do not terminate the agent.
const file = process.argv[2]!;
const config = JSON.parse(readFileSync(file, "utf8")) as {
  executable: string;
  agentKind?: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  resultFile: string;
};
const save = (value: object) => {
  writeFileSync(config.resultFile + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(config.resultFile + ".tmp", config.resultFile);
};
const acp = ["kimi", "grok"].includes(config.agentKind ?? "");
const child = spawn(
  acp ? process.execPath : config.executable,
  acp ? [fileURLToPath(new URL("./acp-terminal.js", import.meta.url)), file] : config.args,
  {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: "inherit",
  },
);
let done = false;
let timedOut = false;
const finish = (state: string, exitCode: number) => {
  if (done) return;
  done = true;
  clearInterval(heartbeat);
  clearTimeout(deadline);
  save({ state, exitCode, observedAt: new Date().toISOString() });
};
const heartbeat = setInterval(
  () => save({ state: "running", pid: child.pid, observedAt: new Date().toISOString() }),
  1000,
);
const deadline = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 1500).unref();
}, config.timeoutMs);
child.once("error", () => finish("failed", 1));
child.once("exit", (code) =>
  finish(!timedOut && code === 0 ? "completed" : "failed", timedOut ? 124 : (code ?? 1)),
);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => {}); // Terminal forwards Ctrl-C to the foreground agent too.
