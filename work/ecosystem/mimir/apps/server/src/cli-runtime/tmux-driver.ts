import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "--pane") {
  const dir = process.argv[3]!;
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  const child = spawn(config.executable, config.args, {
    cwd: config.cwd,
    env: config.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* exited */
    }
  };
  const timer = setInterval(() => {
    try {
      if (Date.now() - statSync(join(dir, "heartbeat")).mtimeMs > 3000) kill();
    } catch {
      kill();
    }
  }, 500);
  let bytes = 0;
  const output = (data: Buffer) => {
    bytes += data.length;
    if (bytes > 32 * 1024 * 1024) kill();
    else appendFileSync(join(dir, "output"), data, { mode: 0o600 });
  };
  child.stdout!.on("data", output);
  child.stderr!.on("data", output);
  child.on("error", () => {});
  child.on("close", (code) => {
    clearInterval(timer);
    writeFileSync(join(dir, "exit"), String(code ?? 1), { mode: 0o600 });
  });
  process.on("SIGTERM", kill);
  process.on("SIGHUP", kill);
} else {
  const dir = mkdtempSync(join(tmpdir(), "mimir-tmux-")),
    name = `mimir-${process.pid}`;
  const tmux = process.env["MIMIR_TMUX_BIN"] ?? "tmux";
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      executable: process.argv[2],
      args: process.argv.slice(3),
      cwd: process.cwd(),
      env: process.env,
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "heartbeat"), "alive", { mode: 0o600 });
  let offset = 0;
  try {
    execFileSync(
      tmux,
      [
        "-L",
        "mimir",
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        name,
        [process.execPath, self, "--pane", dir].map(quote).join(" "),
      ],
      { stdio: "pipe", timeout: 10000 },
    );
    const timer = setInterval(() => {
      writeFileSync(join(dir, "heartbeat"), "alive");
      if (existsSync(join(dir, "output"))) {
        const data = readFileSync(join(dir, "output"));
        process.stdout.write(data.subarray(offset));
        offset = data.length;
      }
      if (existsSync(join(dir, "exit"))) {
        clearInterval(timer);
        const code = Number(readFileSync(join(dir, "exit"), "utf8"));
        rmSync(dir, { recursive: true, force: true });
        process.exitCode = code;
      }
    }, 100);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    process.stderr.write("tmux backend unavailable\n");
    process.exitCode = 1;
  }
}
