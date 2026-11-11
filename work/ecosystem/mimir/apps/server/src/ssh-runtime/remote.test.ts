import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { run } from "./remote.js";

/**
 * The remote entrypoint, in process. Headless jobs fork the real CLI worker from source (Node
 * strips its types) and run a stub agent; interactive jobs drive a scripted terminal runtime, as
 * tmux is outside what these cases check.
 */
const fake = vi.hoisted(() => ({
  script: {} as {
    state?: (round: number) => string | null;
    onReconcile?: (round: number) => void;
    failCreate?: boolean;
    failInput?: boolean;
    capture?: (round: number) => string;
  },
  created: [] as unknown[],
  inputs: [] as unknown[],
  stops: [] as string[],
  disposed: 0,
  healthy: true,
  healthHomes: [] as string[],
  /** Replaces the CLI worker for one case. */
  worker: undefined as string | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (path: string, ...rest: never[]) =>
      actual.fork(fake.worker ?? path.replace(/worker\.js$/, "worker.ts"), ...rest),
  };
});
vi.mock("../terminal-runtime/adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal-runtime/adapter.js")>()),
  TerminalRuntime: class {
    round = 0;
    async createSession(spec: unknown) {
      if (fake.script.failCreate) throw new Error("tmux unavailable");
      fake.created.push(spec);
    }
    async sendInput(_id: string, input: unknown) {
      if (fake.script.failInput) throw new Error("pane closed");
      fake.inputs.push(input);
    }
    async requestStop(_id: string, mode: string) {
      fake.stops.push(mode);
    }
    async reconcile() {
      fake.script.onReconcile?.(this.round);
      this.round++;
    }
    async getSession() {
      const state = (fake.script.state ?? (() => "running"))(this.round);
      return state === null ? null : { state };
    }
    async readTerminal() {
      return fake.script.capture ? fake.script.capture(this.round) : `screen ${this.round}`;
    }
    async dispose() {
      fake.disposed++;
    }
  },
}));
vi.mock("../terminal-runtime/backend.js", () => ({
  NativeTerminalBackend: class {
    constructor(
      readonly name: string,
      readonly home: string,
    ) {}
    async health() {
      fake.healthHomes.push(this.home);
      return fake.healthy;
    }
  },
}));

// Headless cases start real worker and agent processes, several per case.
vi.setConfig({ testTimeout: 180_000 });
const wait = { timeout: 120_000, interval: 50 };

const roots: string[] = [];
let root: string;
let self: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-remote-unit-")));
  roots.push(root);
  vi.stubEnv("MIMIR_REMOTE_ROOT", root);
  // Stands in for the entrypoint script that a submit relaunches detached as `--worker <dir>`.
  self = join(root, "self.cjs");
  writeFileSync(
    self,
    'const {appendFileSync}=require("node:fs");appendFileSync(require("node:path").join(process.argv[3],"spawned"),JSON.stringify(process.argv.slice(2))+"\\n");',
  );
  fake.script = {};
  fake.created = [];
  fake.inputs = [];
  fake.stops = [];
  fake.disposed = 0;
  fake.healthy = true;
  fake.healthHomes = [];
  fake.worker = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** One printed protocol response. */
type Reply = Record<string, unknown> & {
  job?: { state?: string; reason?: string; patch?: string };
  output?: string;
};
async function* stream(chunks: Buffer[]) {
  for (const chunk of chunks) yield chunk;
}
/** Runs the entrypoint once and returns everything it printed. */
async function printed(argv: string[], chunks: Buffer[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await run(argv, stream(chunks), self);
    return log.mock.calls.map((c) => JSON.parse(String(c[0])) as Reply);
  } finally {
    log.mockRestore();
  }
}
async function call(request: unknown, chunks?: Buffer[]) {
  const replies = await printed(
    ["node", "entrypoint"],
    chunks ?? [Buffer.from(typeof request === "string" ? request : JSON.stringify(request))],
  );
  expect(replies).toHaveLength(1);
  return replies[0]!;
}
const req = (operation: string, extra: Record<string, unknown> = {}) => ({
  protocol: 1,
  root,
  operation,
  ...extra,
});
const b64 = (text: string) => Buffer.from(text).toString("base64");
const launch = (extra: Record<string, unknown> = {}) => ({
  backend: "cli",
  agentKind: "codex",
  argv: ["codex", "exec", "hi"],
  taskEnv: { MIMIR_TASK_ID: "t1" },
  timeoutMs: 60_000,
  files: [{ path: "hello.txt", data: b64("original\n"), executable: false }],
  ...extra,
});
async function submitted(jobId: string, payload: Record<string, unknown> = launch()) {
  const reply = await call(req("submit", { jobId, payload }));
  expect(reply).toMatchObject({ ok: true, job: { state: "starting" }, output: "" });
  const dir = join(root, "jobs", jobId);
  await vi.waitFor(() => expect(existsSync(join(dir, "spawned"))).toBe(true), wait);
  return dir;
}
/** Runs the detached worker for a job dir to its end, in process. */
const worker = (dir: string) => printed(["node", "entrypoint", "--worker", dir], []);
const inspect = (jobId: string) => call(req("inspect", { jobId }));
const state = (dir: string) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
function agent(code: string) {
  const path = join(root, `agent-${randomUUID()}`);
  writeFileSync(path, `#!${process.execPath}\n${code}`);
  chmodSync(path, 0o700);
  vi.stubEnv("MIMIR_CODEX_BIN", path);
}

it("answers health for each backend and refuses requests outside its configured root", async () => {
  expect(await call(req("health"))).toMatchObject({
    protocol: 1,
    ok: true,
    agentKinds: ["codex", "claude", "opencode", "gemini", "pi"],
    node: process.version,
  });
  expect(fake.healthHomes).toEqual([]);
  fake.healthy = false;
  expect(await call(req("health", { payload: { backend: "tmux-interactive" } }))).toMatchObject({
    ok: false,
  });
  expect(fake.healthHomes).toEqual([root]);
  expect(statSync(join(root, "jobs")).mode & 0o777).toBe(0o700);

  const refused = "Remote root must match MIMIR_REMOTE_ROOT";
  expect(await call({ ...req("health"), root: join(root, "other") })).toEqual({
    protocol: 1,
    ok: false,
    error: refused,
  });
  vi.stubEnv("MIMIR_REMOTE_ROOT", undefined);
  expect(await call(req("health"))).toMatchObject({ ok: false, error: refused });
  // A symlinked root could redirect job state anywhere.
  const link = join(root, "link");
  symlinkSync(root, link);
  vi.stubEnv("MIMIR_REMOTE_ROOT", link);
  expect(await call({ ...req("health"), root: link })).toMatchObject({
    ok: false,
    error: "Remote state cannot use symlinks",
  });
});

it("rejects malformed, oversized and identity-less requests without touching job state", async () => {
  expect(await call("not json")).toMatchObject({ ok: false, error: expect.any(String) });
  for (const bad of [
    { ...req("inspect"), protocol: 2, jobId: "j" },
    req("exec", { jobId: "j" }),
    req("inspect", { jobId: "../escape" }),
    req("inspect", { jobId: "x".repeat(129) }),
  ])
    expect(await call(bad)).toMatchObject({ ok: false });
  expect(await call(req("inspect"))).toMatchObject({ ok: false, error: "Job identity required" });
  const mib = Buffer.alloc(1024 * 1024, " ");
  expect(
    await call(
      null,
      Array.from({ length: 17 }, () => mib),
    ),
  ).toMatchObject({
    ok: false,
    error: "Request limit exceeded",
  });
  // A stream failing with something other than an Error still yields one protocol reply.
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const failing: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject("stdin closed") }),
  };
  await run(["node", "entrypoint"], failing, self);
  expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
    { protocol: 1, ok: false, error: "remote_request_failed" },
  ]);
  log.mockRestore();
  expect(existsSync(join(root, "jobs", "j"))).toBe(false);
});

it("decodes a request whose multibyte characters span stdin chunks", async () => {
  const body = Buffer.from(
    JSON.stringify(
      req("submit", { jobId: "utf8", payload: launch({ argv: ["codex", "café ü"] }) }),
    ),
  );
  const split = body.indexOf(Buffer.from("é")) + 1;
  await call(null, [body.subarray(0, split), body.subarray(split)]);
  const stored = JSON.parse(readFileSync(join(root, "jobs", "utf8", "request.json"), "utf8"));
  expect(stored.argv).toEqual(["codex", "café ü"]);
});

it("launches a submitted job once and refuses a replay that differs", async () => {
  const dir = await submitted("job-1");
  expect(readFileSync(join(dir, "spawned"), "utf8")).toBe(JSON.stringify(["--worker", dir]) + "\n");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(join(dir, "request.json"), "utf8"))).toEqual(launch());
  const persisted = readFileSync(join(dir, "state.json"), "utf8");
  // An identical replay answers from the persisted job.
  expect(await call(req("submit", { jobId: "job-1", payload: launch() }))).toEqual({
    protocol: 1,
    ok: true,
    job: JSON.parse(persisted),
  });
  expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(persisted);
  expect(
    await call(req("submit", { jobId: "job-1", payload: launch({ argv: ["codex", "other"] }) })),
  ).toEqual({ protocol: 1, ok: false, error: "Job replay mismatch" });
  for (const payload of [
    launch({ agentKind: "bash" }),
    launch({ argv: [] }),
    launch({ argv: ["codex", "a\0b"] }),
    launch({ taskEnv: { AWS_SECRET_ACCESS_KEY: "x" } }),
    launch({ timeoutMs: 50 }),
  ])
    expect(await call(req("submit", { jobId: "job-2", payload }))).toMatchObject({ ok: false });
  expect(existsSync(join(root, "jobs", "job-2"))).toBe(false);
});

it("reports a job directory it cannot create and a worker it cannot start", async () => {
  await call(req("health"));
  chmodSync(join(root, "jobs"), 0o500);
  try {
    expect(await call(req("submit", { jobId: "denied", payload: launch() }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("EACCES"),
    });
  } finally {
    chmodSync(join(root, "jobs"), 0o700);
  }
  const node = process.execPath;
  process.execPath = join(root, "missing-node");
  try {
    expect(await call(req("submit", { jobId: "nostart", payload: launch() }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("ENOENT"),
    });
  } finally {
    process.execPath = node;
  }
});

it("inspects unknown, live and abandoned jobs", async () => {
  expect(await inspect("missing")).toEqual({ protocol: 1, ok: false, error: "job_not_found" });
  const dir = await submitted("job-1");
  writeFileSync(join(dir, "output.log"), "evidence\n");
  expect(await inspect("job-1")).toMatchObject({
    ok: true,
    job: { state: "starting" },
    output: "evidence\n",
  });
  // A live state whose heartbeat is unreadable or old is reported unknown, never as running.
  for (const updatedAt of ["garbage", new Date(Date.now() - 60_000).toISOString()]) {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...state(dir), updatedAt }));
    expect((await inspect("job-1")).job).toMatchObject({
      state: "unknown",
      reason: "worker_heartbeat_lost",
    });
  }
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ ...state(dir), state: "completed", updatedAt: "garbage" }),
  );
  expect((await inspect("job-1")).job).toMatchObject({ state: "completed" });
});

it("records cancellation durably and validates its mode", async () => {
  expect(await call(req("cancel", { jobId: "missing", payload: { mode: "soft" } }))).toMatchObject({
    ok: false,
    error: "job_not_found",
  });
  const dir = await submitted("job-1");
  expect(await call(req("cancel", { jobId: "job-1", payload: { mode: "kill" } }))).toMatchObject({
    ok: false,
  });
  expect(existsSync(join(dir, "cancel"))).toBe(false);
  expect(await call(req("cancel", { jobId: "job-1", payload: { mode: "force" } }))).toMatchObject({
    ok: true,
    job: { state: "starting" },
  });
  expect(readFileSync(join(dir, "cancel"), "utf8")).toBe("force");
});

it("runs a headless agent with only allowlisted environment and returns its changes", async () => {
  agent(
    'require("node:fs").writeFileSync("hello.txt","remote\\n");console.log(JSON.stringify(Object.keys(process.env)))',
  );
  vi.stubEnv("MIMIR_LEAK_PROBE", "secret");
  const dir = await submitted("job-1");
  expect(await worker(dir)).toEqual([]);
  const reply = await inspect("job-1");
  expect(reply.job).toMatchObject({ state: "completed", exitCode: 0 });
  expect(reply.job?.reason).toBeUndefined();
  expect(reply.job?.patch).toContain("+remote");
  const keys = JSON.parse(String(reply.output)) as string[];
  expect(keys).toContain("MIMIR_TASK_ID");
  expect(keys).toContain("PATH");
  for (const leaked of ["MIMIR_LEAK_PROBE", "MIMIR_CODEX_BIN", "MIMIR_REMOTE_ROOT"])
    expect(keys).not.toContain(leaked);
  expect(statSync(join(dir, "output.log")).mode & 0o777).toBe(0o600);
});

it("reports agent failures with their exit code and reason", async () => {
  agent("process.exit(3)");
  const exited = await submitted("exit");
  await worker(exited);
  expect(state(exited)).toMatchObject({ state: "failed", exitCode: 3 });

  vi.stubEnv("MIMIR_CODEX_BIN", join(root, "no-such-agent"));
  const missing = await submitted("missing");
  await worker(missing);
  expect(state(missing)).toMatchObject({ state: "failed", reason: "agent_error" });

  agent('process.stdout.write("x".repeat(3*1024*1024))');
  const noisy = await submitted("noisy");
  await worker(noisy);
  expect(state(noisy)).toMatchObject({ state: "failed", reason: "output_limit" });
  expect(statSync(join(noisy, "output.log")).size).toBeLessThanOrEqual(2 * 1024 * 1024);

  agent('require("node:fs").writeFileSync("big.txt","x\\n".repeat(5*1024*1024))');
  const large = await submitted("large");
  await worker(large);
  expect(state(large)).toMatchObject({ state: "failed", reason: "patch_limit", exitCode: 0 });
  expect(state(large).patch).toBeUndefined();
});

it("stops a headless agent at its wall-clock limit or on a durable cancellation", async () => {
  agent("setInterval(()=>{},1000)");
  const slow = await submitted("slow", launch({ timeoutMs: 100 }));
  await worker(slow);
  // The worker and its watchdog share the limit; either may report it first.
  expect(state(slow)).toMatchObject({
    state: "failed",
    reason: expect.stringMatching(/^(wall_clock_limit|agent_timeout)$/),
  });

  const cancelled = await submitted("cancelled");
  await call(req("cancel", { jobId: "cancelled", payload: { mode: "soft" } }));
  await worker(cancelled);
  expect(state(cancelled)).toMatchObject({ state: "stopped" });
});

it("fails a job whose workspace cannot be restored and reports an unreadable request", async () => {
  const dir = await submitted(
    "unsafe",
    launch({ files: [{ path: "../escape", data: "", executable: false }] }),
  );
  await worker(dir);
  expect(state(dir)).toMatchObject({ state: "failed", reason: "remote_worker_error" });
  expect(existsSync(join(dir, "escape"))).toBe(false);

  writeFileSync(join(dir, "request.json"), "{}");
  expect(await worker(dir)).toMatchObject([{ protocol: 1, ok: false }]);
});

const interactive = (extra: Record<string, unknown> = {}) =>
  launch({ backend: "tmux-interactive", agentKind: "claude", argv: ["claude"], ...extra });
const command = (operation: "input" | "keys", body: Record<string, unknown>, id = randomUUID()) =>
  req(operation, { jobId: "job-i", payload: { commandId: id, ...body } });

it("delivers interactive input once per command identity and returns the session's changes", async () => {
  let finished = false;
  fake.script = {
    state: () => (finished ? "completed" : "running"),
    onReconcile: () => {
      if (fake.inputs.length) writeFileSync(join(dir, "workspace", "hello.txt"), "typed\n");
    },
  };
  const dir = await submitted("job-i", interactive({ taskEnv: { MIMIR_TASK_ID: "t1" } }));
  const running = worker(dir);
  await vi.waitFor(() => expect(state(dir).state).toBe("running"), wait);
  expect(fake.created).toMatchObject([
    { argv: ["claude"], cwd: join(dir, "workspace"), env: { MIMIR_TASK_ID: "t1" } },
  ]);

  const id = randomUUID();
  expect(await call(command("input", { text: "hello" }, id))).toMatchObject({
    ok: true,
    job: { state: "running" },
  });
  expect(await call(command("keys", { keys: ["Enter"] }))).toMatchObject({ ok: true });
  expect(fake.inputs).toEqual([{ text: "hello" }, { keys: ["Enter"] }]);
  // A replayed command is answered from its receipt and never typed twice.
  expect(await call(command("input", { text: "hello" }, id))).toEqual({ protocol: 1, ok: true });
  expect(await call(command("input", { text: "changed" }, id))).toMatchObject({
    ok: false,
    error: "Control replay mismatch",
  });
  for (const payload of [
    { commandId: "not-a-uuid", text: "x" },
    { commandId: randomUUID(), text: "" },
    { commandId: randomUUID(), keys: [] },
    { commandId: randomUUID(), text: "x", extra: true },
  ])
    expect(await call(req("input", { jobId: "job-i", payload }))).toMatchObject({ ok: false });
  expect(fake.inputs).toHaveLength(2);

  fake.script.failInput = true;
  const lost = randomUUID();
  expect(await call(command("input", { text: "lost" }, lost))).toMatchObject({
    ok: false,
    error: "Control outcome uncertain",
  });
  expect(await call(command("input", { text: "lost" }, lost))).toEqual({
    protocol: 1,
    ok: false,
    error: "control_outcome_unknown",
  });

  finished = true;
  await running;
  expect(state(dir)).toMatchObject({ state: "completed", exitCode: 0 });
  expect(state(dir).patch).toContain("+typed");
  expect(fake.disposed).toBe(1);
  // With the worker gone nothing dispatches the command: the caller learns it is unconfirmed.
  expect(await call(command("keys", { keys: ["Enter"] }))).toMatchObject({
    ok: false,
    error: "Control delivery unconfirmed; inspect before sending again",
  });
});

it("refuses interactive control for a headless job", async () => {
  await submitted("job-i");
  expect(await call(command("input", { text: "hi" }))).toMatchObject({
    ok: false,
    error: "Interactive backend required",
  });
  expect(await call(command("keys", { keys: ["Enter"] }))).toMatchObject({ ok: false });
});

it("cancels an interactive session and keeps the last captured output", async () => {
  fake.script = {
    state: () => (fake.stops.length ? "stopped" : "running"),
    capture: (round) => {
      if (round > 1) throw new Error("pane closed");
      return "last screen";
    },
  };
  const dir = await submitted("job-i", interactive());
  const running = worker(dir);
  await vi.waitFor(() => expect(state(dir).state).toBe("running"), wait);
  await call(req("cancel", { jobId: "job-i", payload: { mode: "soft" } }));
  await running;
  expect(fake.stops).toEqual(["soft"]);
  expect(state(dir)).toMatchObject({ state: "stopped", exitCode: 1, patch: "" });
  expect(readFileSync(join(dir, "output.log"), "utf8")).toBe("last screen");

  fake.stops = [];
  fake.script = { state: () => (fake.stops.length ? "failed" : "running") };
  const forced = await submitted("job-f", interactive());
  writeFileSync(join(forced, "cancel"), "force");
  await worker(forced);
  expect(fake.stops).toEqual(["force"]);
  expect(state(forced)).toMatchObject({ state: "failed", exitCode: 1 });
});

it("reports an interactive session it cannot observe as unknown", async () => {
  fake.script = { state: (round) => (round < 2 ? null : "completed") };
  const vanished = await submitted("vanished", interactive());
  const seen: string[] = [];
  fake.script.onReconcile = (round) => {
    if (round === 1) seen.push(state(vanished).state);
  };
  await worker(vanished);
  expect(seen).toEqual(["unknown"]);
  expect(state(vanished)).toMatchObject({ state: "completed" });

  fake.script = { failCreate: true };
  const broken = await submitted("broken", interactive());
  await worker(broken);
  expect(state(broken)).toMatchObject({
    state: "unknown",
    reason: "interactive_worker_unconfirmed",
  });
  expect(fake.disposed).toBe(2);

  fake.script = { state: () => "running" };
  const stuck = await submitted("stuck", interactive({ timeoutMs: 100 }));
  const running = worker(stuck);
  await vi.waitFor(() => expect(state(stuck).state).toBe("running"), wait);
  // Past the observation deadline (limit + 30 s) the worker stops claiming a live session.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
  await running;
  vi.useRealTimers();
  expect(state(stuck)).toMatchObject({ state: "unknown", reason: "interactive_exit_unconfirmed" });
});

it("refuses an interactive result whose patch exceeds the limit", async () => {
  fake.script = {
    state: (round) => (round < 1 ? "running" : "completed"),
    onReconcile: (round) => {
      if (round === 0)
        writeFileSync(join(dir, "workspace", "big.txt"), "x\n".repeat(5 * 1024 * 1024));
    },
  };
  const dir = await submitted("job-i", interactive());
  await worker(dir);
  expect(state(dir)).toMatchObject({ state: "failed", reason: "patch_limit", exitCode: 0 });
  expect(state(dir).patch).toBeUndefined();
});

it("leaves control receipts it does not own alone", async () => {
  let finished = false;
  fake.script = { state: () => (finished ? "completed" : "running") };
  const dir = await submitted("job-i", interactive());
  mkdirSync(join(dir, "control-not-json"));
  const done = join(dir, `control-${randomUUID()}.json`);
  writeFileSync(done, JSON.stringify({ state: "done", operation: "input", text: "old" }));
  const running = worker(dir);
  await vi.waitFor(() => expect(state(dir).state).toBe("running"), wait);
  finished = true;
  await running;
  expect(fake.inputs).toEqual([]);
  expect(JSON.parse(readFileSync(done, "utf8")).state).toBe("done");
});

it("waits for a control receipt that is still being written instead of abandoning the session", async () => {
  let finished = false,
    rounds = 0;
  fake.script = {
    state: () => (finished ? "completed" : "running"),
    onReconcile: () => rounds++,
  };
  const dir = await submitted("job-i", interactive());
  // The entrypoint creates a receipt and then writes it, so the worker can see it empty.
  const receipt = join(dir, `control-${randomUUID()}.json`);
  writeFileSync(receipt, "");
  const running = worker(dir);
  await vi.waitFor(() => expect(rounds).toBeGreaterThanOrEqual(2), wait);
  expect(state(dir).state).toBe("running");
  writeFileSync(
    receipt,
    JSON.stringify({ fingerprint: "f", state: "queued", operation: "input", text: "late" }),
  );
  await vi.waitFor(
    () => expect(JSON.parse(readFileSync(receipt, "utf8")).state).toBe("done"),
    wait,
  );
  expect(fake.inputs).toEqual([{ text: "late" }]);
  finished = true;
  await running;
  expect(state(dir)).toMatchObject({ state: "completed" });
});

it("runs the harness found on PATH when no binary is configured for it", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\nconsole.log("path codex")`);
  chmodSync(join(bin, "codex"), 0o700);
  vi.stubEnv("MIMIR_CODEX_BIN", undefined);
  vi.stubEnv("PATH", `${bin}:${process.env["PATH"]}`);
  const dir = await submitted("job-1");
  await worker(dir);
  expect(await inspect("job-1")).toMatchObject({
    job: { state: "completed" },
    output: "path codex\n",
  });
});

it("tolerates a worker that omits fields and stops listening before it exits", async () => {
  // Sends bare messages, then closes IPC and lingers: cancellation can no longer be delivered.
  fake.worker = join(root, "worker.cjs");
  writeFileSync(
    fake.worker,
    'process.on("message",(m)=>{if(m.kind!=="start")return;process.send({kind:"output"});process.send({kind:"exit"},()=>{process.disconnect();setTimeout(()=>{},1500)})})',
  );
  const dir = await submitted("job-1");
  await call(req("cancel", { jobId: "job-1", payload: { mode: "force" } }));
  await worker(dir);
  expect(state(dir)).toMatchObject({ state: "stopped", exitCode: 1 });
  expect(readFileSync(join(dir, "output.log"), "utf8")).toBe("");
});
