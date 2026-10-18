import { spawn, type ChildProcess } from "node:child_process";

let child: ChildProcess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let bytes = 0;
const send = (message: unknown) => {
  if (process.connected) process.send?.(message);
};
const kill = (signal: NodeJS.Signals = "SIGKILL") => {
  try {
    if (child?.pid) process.kill(-child.pid, signal);
  } catch {
    /* already stopped */
  }
};
// IPC closes even if the server is SIGKILLed: never leave a coding agent orphaned.
process.on("disconnect", () => {
  kill();
  process.exit(0);
});
process.on(
  "message",
  (message: {
    kind: string;
    force?: boolean;
    executable?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }) => {
    if (message.kind === "stop") {
      kill(message.force ? "SIGKILL" : "SIGTERM");
      setTimeout(() => kill(), 1500).unref();
      return;
    }
    if (message.kind !== "start" || child) return;
    child = spawn(message.executable!, message.args!, {
      cwd: message.cwd!,
      env: message.env!,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    timer = setTimeout(() => {
      send({ kind: "timeout" });
      kill();
    }, message.timeoutMs ?? 1_200_000);
    const output = (data: Buffer, stderr: boolean) => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) {
        send({ kind: "limit" });
        kill();
      } else send({ kind: "output", text: data.toString("utf8"), stderr });
    };
    child.stdout!.on("data", (data: Buffer) => output(data, false));
    child.stderr!.on("data", (data: Buffer) => output(data, true));
    child.on("error", () => send({ kind: "error" }));
    child.on("close", (code) => {
      clearTimeout(timer);
      // Flush queued output and the terminal event before closing IPC. Immediate disconnect
      // can discard the exit message under heavy output and misreport a lost watchdog.
      if (process.connected)
        process.send?.({ kind: "exit", code: code ?? 1 }, () => {
          if (process.connected) process.disconnect?.();
        });
    });
  },
);
