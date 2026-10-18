import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AcpClient } from "./acp-client.js";
const config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const child = spawn(config.executable, config.args, {
  cwd: config.cwd,
  env: { ...process.env, ...config.env },
  stdio: ["pipe", "pipe", "inherit"],
  detached: true,
});
const print = (text: string) =>
  process.stdout.write(
    Array.from(text)
      .filter((char) => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
      })
      .join(""),
  );
let ending = false;
function shutdown(code: number) {
  if (ending) return;
  ending = true;
  process.exitCode = code;
  process.stdin.pause();
  const signal = (name: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch {
      child.kill(name);
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 1500);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
const client = new AcpClient(
  child.stdin,
  child.stdout,
  {
    output: print,
    state: (state, reason) => {
      const file = config.env.MIMIR_HOOK_FILE;
      const temporary = file + "." + randomUUID();
      writeFileSync(
        temporary,
        JSON.stringify({ id: randomUUID(), state, reason, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      renameSync(temporary, file);
    },
    failure: (error) => {
      if (!ending) {
        print(`\n${error.message}\n`);
        shutdown(1);
      }
    },
  },
  config.timeoutMs,
);
child.once("error", (error) => {
  print(`\nUnable to start agent: ${error.message}\n`);
  shutdown(1);
  client.close();
});
child.once("exit", () => {
  if (!ending) shutdown(1);
  client.close();
});
process.on("SIGINT", () => client.cancel());
process.on("SIGTERM", () => {
  client.cancel();
  shutdown(0);
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 65536) {
    buffer = "";
    print("\nInput exceeds 64 KiB. Nothing submitted.\n");
    return;
  }
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line === "/quit") {
      client.cancel();
      shutdown(0);
      return;
    }
    void client.operatorInput(line).catch((error) => print(`\n${error.message}\n`));
  }
});
process.stdin.once("end", () => {
  client.cancel();
  shutdown(0);
});
try {
  await client.initialize(config.cwd, config.agentKind);
  print(
    "Mimir ACP terminal. /cancel cancels a turn; /quit closes the session. Permissions require an explicit /permit response.\n",
  );
  await client.prompt(config.prompt);
} catch (error) {
  print(`\n${(error as Error).message}\n`);
  shutdown(1);
  client.close();
}
