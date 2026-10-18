import { spawn, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { git, restore, MAX_WORKSPACE_BYTES } from "./workspace.js";

import { TerminalRuntime, INTERACTIVE_HARNESSES } from "../terminal-runtime/adapter.js";
import { NativeTerminalBackend } from "../terminal-runtime/backend.js";
const fileSchema = z.object({ path: z.string(), data: z.string(), executable: z.boolean() });
const launchSchema = z.object({
  backend: z.enum(["cli", "tmux-interactive"]).default("cli"),
  agentKind: z.string().refine((k) => INTERACTIVE_HARNESSES.includes(k)),
  argv: z.array(z.string().refine((s) => !s.includes("\0"))).min(1),
  taskEnv: z
    .object({ MIMIR_TASK_ID: z.string().optional(), MIMIR_MISSION_ID: z.string().optional() })
    .strict()
    .default({}),
  timeoutMs: z.number().int().min(100).max(86400000),
  files: z.array(fileSchema).max(10000),
});
const requestSchema = z.object({
  protocol: z.literal(1),
  root: z.string(),
  operation: z.enum(["health", "submit", "inspect", "cancel", "input", "keys"]),
  jobId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  payload: z.unknown().optional(),
});
type Job = {
  state:
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "stopped"
    | "unknown"
    | "waiting"
    | "blocked"
    | "stopping";
  updatedAt: string;
  fingerprint: string;
  exitCode?: number;
  reason?: string;
  patch?: string;
};
function flushDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function atomic(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flush: true });
  renameSync(temp, path);
  flushDirectory(dirname(path));
}
function directory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
    throw new Error("Remote state cannot use symlinks");
  flushDirectory(path);
  flushDirectory(dirname(path));
}
function readJob(dir: string): Job {
  const job = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Job;
  if (
    ["running", "starting", "waiting", "blocked", "stopping"].includes(job.state) &&
    (!Number.isFinite(Date.parse(job.updatedAt)) || Date.now() - Date.parse(job.updatedAt) > 30000)
  ) {
    job.state = "unknown";
    job.reason = "worker_heartbeat_lost";
  }
  return job;
}
const self = fileURLToPath(import.meta.url);
function terminal(dir: string) {
  const home = join(dir, "terminal");
  return new TerminalRuntime(new NativeTerminalBackend("tmux-interactive", home), home);
}
async function runInteractive(dir: string, payload: z.infer<typeof launchSchema>, job: Job) {
  let cancelled = false;
  const observationDeadline = Date.now() + payload.timeoutMs + 30000;
  const runtime = terminal(dir),
    cwd = join(dir, "workspace");
  const save = () => {
    job.updatedAt = new Date().toISOString();
    atomic(join(dir, "state.json"), job);
  };
  try {
    await runtime.createSession({
      sessionId: "remote",
      idempotencyKey: "remote",
      crewId: "remote",
      taskId: "remote",
      workspaceLabel: "Remote interactive task",
      agentKind: payload.agentKind,
      argv: payload.argv,
      cwd,
      env: Object.fromEntries(
        Object.entries(payload.taskEnv).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      timeoutMs: payload.timeoutMs,
    });
    while (true) {
      if (Date.now() > observationDeadline) {
        job.state = "unknown";
        job.reason = "interactive_exit_unconfirmed";
        save();
        break;
      }
      for (const name of readdirSync(dir).filter((n) => /^control-[a-f0-9-]+\.json$/.test(n))) {
        const file = join(dir, name),
          command = JSON.parse(readFileSync(file, "utf8"));
        if (command.state !== "queued") continue;
        atomic(file, { ...command, state: "dispatching" });
        try {
          await runtime.sendInput(
            "remote",
            command.operation === "input" ? { text: command.text } : { keys: command.keys },
          );
          atomic(file, { ...command, state: "done" });
        } catch {
          atomic(file, { ...command, state: "uncertain" });
        }
      }
      if (!cancelled && existsSync(join(dir, "cancel"))) {
        cancelled = true;
        const mode = readFileSync(join(dir, "cancel"), "utf8").trim();
        await runtime.requestStop("remote", mode === "force" ? "force" : "soft");
      }
      await runtime.reconcile();
      const session = await runtime.getSession("remote");
      job.state = (session?.state ?? "unknown") as Job["state"];
      try {
        writeFileSync(
          join(dir, "output.log"),
          (await runtime.readTerminal("remote", 5000)).slice(-2 * 1024 * 1024),
          { mode: 0o600 },
        );
      } catch {
        /* Pane may close before final capture; retain previous evidence. */
      }
      if (["completed", "failed", "stopped"].includes(job.state)) {
        job.exitCode = job.state === "completed" ? 0 : 1;
        git(cwd, ["add", "-A"]);
        const patch = git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
        if (Buffer.byteLength(patch) > MAX_WORKSPACE_BYTES) {
          job.state = "failed";
          job.reason = "patch_limit";
        } else job.patch = patch;
        save();
        break;
      }
      save();
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    job.state = "unknown";
    job.reason = "interactive_worker_unconfirmed";
    save();
  } finally {
    await runtime.dispose();
  }
}
async function runWorker(dir: string) {
  const payload = launchSchema.parse(JSON.parse(readFileSync(join(dir, "request.json"), "utf8")));
  const job = readJob(dir),
    cwd = join(dir, "workspace");
  const save = () => {
    job.updatedAt = new Date().toISOString();
    atomic(join(dir, "state.json"), job);
  };
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false,
    failure: string | undefined,
    total = 0;
  const kill = () => {
    try {
      if (child?.connected) child.send({ kind: "stop", force: true });
    } catch {
      /* already exited */
    }
  };
  try {
    directory(cwd);
    restore(cwd, payload.files);
    git(cwd, ["init", "--quiet"]);
    git(cwd, ["add", "-A"]);
    git(cwd, [
      "-c",
      "user.name=Mimir",
      "-c",
      "user.email=mimir@localhost",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Remote input",
    ]);
    if (payload.backend === "tmux-interactive") {
      await runInteractive(dir, payload, job);
      return;
    }
    const executable =
      process.env[`MIMIR_${payload.agentKind.toUpperCase()}_BIN`] ?? payload.agentKind;
    const env = Object.fromEntries(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    );
    child = fork(fileURLToPath(new URL("../cli-runtime/worker.js", import.meta.url)), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    job.state = "running";
    save();
    const output = (buffer: Buffer) => {
      total += buffer.length;
      if (total > 2 * 1024 * 1024) {
        failure = "output_limit";
        kill();
      } else appendFileSync(join(dir, "output.log"), buffer, { mode: 0o600, flush: true });
    };
    let exitCode = 1;
    child.on("message", (message: { kind: string; text?: string; code?: number }) => {
      if (message.kind === "output") output(Buffer.from(message.text ?? ""));
      if (message.kind === "exit") exitCode = message.code ?? 1;
      if (["error", "timeout", "limit"].includes(message.kind)) failure = `agent_${message.kind}`;
    });
    const heartbeat = setInterval(() => {
      if (existsSync(join(dir, "cancel"))) {
        stopped = true;
        if (child?.connected)
          child.send({
            kind: "stop",
            force: readFileSync(join(dir, "cancel"), "utf8").trim() === "force",
          });
      }
      save();
    }, 500);
    const deadline = setTimeout(() => {
      failure = "wall_clock_limit";
      kill();
    }, payload.timeoutMs);
    const code = await new Promise<number>((done) => {
      child!.on("error", () => {
        failure = "agent_unavailable";
      });
      child!.on("exit", () => done(exitCode));
      child!.send({
        kind: "start",
        executable,
        args: payload.argv.slice(1),
        cwd,
        env: { ...env, ...payload.taskEnv },
        timeoutMs: payload.timeoutMs,
      });
    });
    clearInterval(heartbeat);
    clearTimeout(deadline);
    job.exitCode = code;
    job.state = stopped ? "stopped" : code === 0 && !failure ? "completed" : "failed";
    if (failure) job.reason = failure;
    git(cwd, ["add", "-A"]);
    const patch = git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
    if (Buffer.byteLength(patch) > MAX_WORKSPACE_BYTES) {
      job.state = "failed";
      job.reason = "patch_limit";
    } else job.patch = patch;
    save();
  } catch {
    kill();
    job.state = "failed";
    job.reason = "remote_worker_error";
    save();
  }
}
async function main() {
  if (process.argv[2] === "--worker") {
    await runWorker(process.argv[3]!);
    return;
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error("Request limit exceeded");
  }
  const request = requestSchema.parse(JSON.parse(input));
  const configured = process.env["MIMIR_REMOTE_ROOT"];
  if (!configured || resolve(request.root) !== resolve(configured))
    throw new Error("Remote root must match MIMIR_REMOTE_ROOT");
  directory(configured);
  directory(join(configured, "jobs"));
  if (request.operation === "health") {
    const interactive =
      (request.payload as { backend?: string } | undefined)?.backend === "tmux-interactive";
    const healthy =
      !interactive || (await new NativeTerminalBackend("tmux-interactive", configured).health());
    console.log(
      JSON.stringify({
        protocol: 1,
        ok: healthy,
        agentKinds: ["codex", "claude", "opencode", "gemini", "pi"],
        node: process.version,
      }),
    );
    return;
  }
  if (!request.jobId) throw new Error("Job identity required");
  const dir = join(configured, "jobs", request.jobId);
  if (request.operation === "submit") {
    const payload = launchSchema.parse(request.payload);
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    try {
      mkdirSync(dir, { mode: 0o700 });
      flushDirectory(dirname(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readJob(dir).fingerprint !== fingerprint)
        throw new Error("Job replay mismatch", { cause: error });
      console.log(JSON.stringify({ protocol: 1, ok: true, job: readJob(dir) }));
      return;
    }
    atomic(join(dir, "request.json"), payload);
    atomic(join(dir, "state.json"), {
      fingerprint,
      state: "starting",
      updatedAt: new Date().toISOString(),
    });
    const worker = spawn(process.execPath, [self, "--worker", dir], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    await new Promise<void>((done, reject) => {
      worker.once("spawn", done);
      worker.once("error", reject);
    });
    worker.unref();
  } else if (!existsSync(join(dir, "state.json"))) {
    console.log(JSON.stringify({ protocol: 1, ok: false, error: "job_not_found" }));
    return;
  }
  if (request.operation === "cancel") {
    writeFileSync(
      join(dir, "cancel"),
      z.object({ mode: z.enum(["soft", "force"]) }).parse(request.payload).mode,
      { mode: 0o600, flush: true },
    );
    flushDirectory(dir);
  }
  if (request.operation === "input" || request.operation === "keys") {
    const launch = launchSchema.parse(JSON.parse(readFileSync(join(dir, "request.json"), "utf8")));
    if (launch.backend !== "tmux-interactive") throw new Error("Interactive backend required");
    const control = z
      .object({
        commandId: z.string().uuid(),
        text: z.string().min(1).max(16000).optional(),
        keys: z.array(z.string()).min(1).max(8).optional(),
      })
      .strict()
      .parse(request.payload);
    const receipt = join(dir, "control-" + control.commandId + ".json");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.operation, control]))
      .digest("hex");
    if (existsSync(receipt)) {
      const prior = JSON.parse(readFileSync(receipt, "utf8"));
      if (prior.fingerprint !== fingerprint) throw new Error("Control replay mismatch");
      console.log(
        JSON.stringify({
          protocol: 1,
          ok: prior.state === "done",
          error: prior.state === "done" ? undefined : "control_outcome_unknown",
        }),
      );
      return;
    }
    writeFileSync(
      receipt,
      JSON.stringify({ fingerprint, state: "queued", operation: request.operation, ...control }),
      { mode: 0o600, flag: "wx", flush: true },
    );
    flushDirectory(dir);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = JSON.parse(readFileSync(receipt, "utf8"));
      if (result.state === "done") break;
      if (result.state === "uncertain") throw new Error("Control outcome uncertain");
      await new Promise((r) => setTimeout(r, 100));
    }
    if (JSON.parse(readFileSync(receipt, "utf8")).state !== "done")
      throw new Error("Control delivery unconfirmed; inspect before sending again");
  }
  const job = readJob(dir);
  const output = existsSync(join(dir, "output.log"))
    ? readFileSync(join(dir, "output.log"), "utf8")
    : "";
  console.log(JSON.stringify({ protocol: 1, ok: true, job, output }));
}
main().catch((error) => {
  console.log(
    JSON.stringify({
      protocol: 1,
      ok: false,
      error: error instanceof Error ? error.message : "remote_request_failed",
    }),
  );
});
