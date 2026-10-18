import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CheckReason } from "@brokkr/core";
import { ProcessTracker, outputPipeHolders } from "./tracker.js";

/** Streaming output filter (e.g. secret redaction) applied before output is stored anywhere. */
export interface OutputRedactor {
  write(chunk: string): string;
  flush(): string;
  readonly findings: number;
}

/** What to run (spec §12.3). The executor adds nothing to `env`. */
export interface CheckExecutionRequest {
  checkId: string;
  /** argv array; never interpreted by a shell. */
  command: string[];
  /** Absolute workspace root; the working directory must stay inside it. */
  workspace: string;
  /** Working directory relative to the workspace (default `.`). */
  cwd?: string;
  /** Complete, already-filtered environment for the child. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Absolute log file; output is streamed here. */
  logFile?: string;
  /** Total bytes written to the log before it is truncated (default 10 MiB). */
  maxLogBytes?: number;
  /** Bytes of output kept in memory (default 64 KiB). */
  tailBytes?: number;
  /** Grace period between SIGTERM and SIGKILL (default 5 s). */
  killGraceMs?: number;
  /** Factory for one redactor per output stream (stdout, stderr). */
  createRedactor?: () => OutputRedactor;
}

export type ExecutionState = "passed" | "failed" | "errored" | "timed_out" | "cancelled";

export interface CheckExecutionResult {
  checkId: string;
  state: ExecutionState;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  pid?: number;
  /** Last `tailBytes` of (redacted) output. */
  outputTail: string;
  /** Total bytes of output produced (before truncation). */
  outputBytes: number;
  /** True when the log was cut at `maxLogBytes`. */
  truncated: boolean;
  /** Sampled peak resident set size of the check's main process, when available. */
  maxRssBytes?: number;
  secretFindings: number;
  reason?: CheckReason;
  error?: string;
}

/** Executor abstraction (spec §12.3): Mimir can inject a sandbox-aware implementation. */
export interface CheckExecutor {
  execute(request: CheckExecutionRequest, signal?: AbortSignal): Promise<CheckExecutionResult>;
}

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** Grace between SIGTERM and SIGKILL on cancellation (Ctrl-C), capped so the partial report is written promptly. */
export const CANCEL_GRACE_MS = 1_000;
/** Upper bound for each post-exit cleanup step (descendant search, pipe-holder search). */
export const CLEANUP_STEP_MS = 5_000;

/** Resolve with `fallback` if `work` takes longer than `ms`. */
function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((res) => {
    const t = setTimeout(() => res(fallback), ms);
    t.unref();
    work.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      () => {
        clearTimeout(t);
        res(fallback);
      },
    );
  });
}

/** Resolve the working directory and require its realpath to stay inside the workspace realpath. */
export async function resolveWorkingDirectory(
  workspace: string,
  cwd = ".",
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  if (isAbsolute(cwd)) return { ok: false, error: `cwd '${cwd}' must be relative` };
  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    return { ok: false, error: `workspace ${workspace} does not exist` };
  }
  const target = resolve(root, cwd);
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || isAbsolute(lexical))
    return { ok: false, error: `cwd '${cwd}' is outside the workspace` };
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return { ok: false, error: `cwd '${cwd}' does not exist` };
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel))
    return { ok: false, error: `cwd '${cwd}' resolves to ${real}, outside the workspace` };
  return { ok: true, dir: real };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

/** Sample peak RSS: /proc VmHWM on Linux, `ps -o rss=` elsewhere. Best effort. */
function startRssSampler(pid: number): { stop: () => number | undefined } {
  let max: number | undefined;
  let stopped = false;
  const sample = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        const kb = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1]);
        if (kb > 0) max = Math.max(max ?? 0, kb * 1024);
      } else if (process.platform === "darwin") {
        const kb = await new Promise<number>((res) =>
          execFile("ps", ["-o", "rss=", "-p", String(pid)], (err, out) =>
            res(err ? 0 : Number(out.trim())),
          ),
        );
        if (kb > 0) max = Math.max(max ?? 0, kb * 1024);
      }
    } catch {
      // process exited between samples
    }
  };
  void sample();
  // /proc reads are cheap; on macOS every sample spawns `ps`, so sample once a second.
  const timer = setInterval(() => void sample(), process.platform === "linux" ? 250 : 1000);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      return max;
    },
  };
}

/**
 * Runs checks as local child processes: argv only (`shell: false`), cwd
 * confined to the workspace, exactly the given environment, its own process
 * group (killed on timeout, cancellation and exit), bounded log and tail.
 * This is not an OS sandbox (ADR-004).
 */
export class LocalProcessExecutor implements CheckExecutor {
  async execute(
    request: CheckExecutionRequest,
    signal?: AbortSignal,
  ): Promise<CheckExecutionResult> {
    const startedAt = new Date();
    const base = {
      checkId: request.checkId,
      exitCode: null,
      signal: null,
      outputTail: "",
      outputBytes: 0,
      truncated: false,
      secretFindings: 0,
    };
    const finish = (
      extra: Partial<CheckExecutionResult> & { state: ExecutionState },
    ): CheckExecutionResult => {
      const completedAt = new Date();
      return {
        ...base,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...extra,
      };
    };

    if (signal?.aborted) return finish({ state: "cancelled", reason: "cancelled" });
    const cwd = await resolveWorkingDirectory(request.workspace, request.cwd);
    if (!cwd.ok) return finish({ state: "errored", reason: "cwd_rejected", error: cwd.error });
    const [file, ...args] = request.command;
    if (file === undefined)
      return finish({ state: "errored", reason: "invalid_command", error: "empty command" });

    const maxLog = request.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    const tailMax = request.tailBytes ?? DEFAULT_TAIL_BYTES;
    let log: WriteStream | undefined;
    if (request.logFile) {
      await mkdir(dirname(request.logFile), { recursive: true });
      log = createWriteStream(request.logFile, { flags: "w" });
    }
    let logged = 0;
    let truncated = false;
    let outputBytes = 0;
    let tail = "";
    const store = (text: string): void => {
      if (text.length === 0) return;
      tail = (tail + text).slice(-tailMax);
      if (!log || truncated) return;
      const bytes = Buffer.byteLength(text);
      if (logged + bytes <= maxLog) {
        log.write(text);
        logged += bytes;
        return;
      }
      const room = Buffer.from(text).subarray(0, Math.max(0, maxLog - logged));
      log.write(room);
      log.write(`\n[brokkr: log truncated at ${maxLog} bytes]\n`);
      logged = maxLog;
      truncated = true;
    };

    const token = randomUUID();
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: cwd.dir,
        // The token lets the tracker find descendants after they leave the group (Linux).
        env: {
          ...request.env,
          BROKKR_CHECK_TOKEN: token,
          // pnpm 10+ installs dependencies before `pnpm test`/`pnpm run` (verify-deps-before-run),
          // which would bypass the install-dependencies approval: never let it.
          npm_config_verify_deps_before_run: "false",
          pnpm_config_verify_deps_before_run: "false",
        },
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      log?.end();
      return finish({ state: "errored", reason: "spawn_error", error: (error as Error).message });
    }

    const redactors: OutputRedactor[] = [];
    const finishers: Array<() => void> = [];
    const pipe = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      const decoder = new StringDecoder("utf8");
      const redactor = request.createRedactor?.();
      if (redactor) redactors.push(redactor);
      let done = false;
      const finishStream = (): void => {
        if (done) return;
        done = true;
        const rest = decoder.end();
        store(redactor ? redactor.write(rest) + redactor.flush() : rest);
      };
      finishers.push(finishStream);
      stream.on("data", (chunk: Buffer) => {
        if (done) return;
        outputBytes += chunk.length;
        const text = decoder.write(chunk);
        store(redactor ? redactor.write(text) : text);
      });
      stream.on("end", finishStream);
    };
    pipe(child.stdout);
    pipe(child.stderr);

    const sampler = child.pid !== undefined ? startRssSampler(child.pid) : undefined;
    const tracker = child.pid !== undefined ? new ProcessTracker(child.pid, token) : undefined;
    tracker?.start();
    const grace = request.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const cancelGrace = Math.min(grace, CANCEL_GRACE_MS);
    let outcome: "timed_out" | "cancelled" | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const terminate = (why: "timed_out" | "cancelled"): void => {
      if (outcome) return;
      outcome = why;
      killGroup(child, "SIGTERM");
      graceTimer = setTimeout(
        () => killGroup(child, "SIGKILL"),
        why === "cancelled" ? cancelGrace : grace,
      );
    };
    const timer = setTimeout(() => terminate("timed_out"), request.timeoutMs);
    const onAbort = (): void => terminate("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const spawnError = await new Promise<Error | undefined>((res) => {
      child.once("error", (error) => res(error));
      child.once("exit", () => res(undefined));
    });
    // The deadline bounds the main process; post-exit cleanup is bounded separately,
    // so a check that already exited is never reported as timed out.
    clearTimeout(timer);
    let exitCode: number | null = child.exitCode;
    let exitSignal: string | null = child.signalCode;
    const orphanNotes: string[] = [];
    const orphanNote =
      "output pipe held by a process outside the process group (it escaped with setsid/detach); pipes closed";
    if (!spawnError) {
      // The main process exited: kill anything it left behind in its group, then drain
      // output. A descendant outside the group (setsid/detached) may hold the pipes open
      // forever, so the drain is bounded by the kill grace and the pipes are then closed.
      killGroup(child, "SIGKILL");
      // Descendants that left the group (setsid, double fork) are found and killed too;
      // their existence fails the check.
      const escaped = tracker
        ? await withinMs(tracker.killSurvivors(), CLEANUP_STEP_MS, { found: [], remaining: [] })
        : undefined;
      if (escaped && escaped.found.length > 0) {
        orphanNotes.push(
          `${escaped.found.length} descendant process(es) outlived the check (left its process group) and were killed` +
            (escaped.remaining.length > 0
              ? `; ${escaped.remaining.length} could not be killed`
              : ""),
        );
      }
      const open = (): boolean =>
        child.stdout?.readableEnded === false || child.stderr?.readableEnded === false;
      if (open()) {
        await new Promise<void>((res) => {
          const t = setTimeout(res, Math.min(grace, outcome === "cancelled" ? cancelGrace : grace));
          child.once("close", () => {
            clearTimeout(t);
            res();
          });
        });
      }
      if (open()) {
        // A descendant the tracker missed still holds our pipes: find it by the pipe and kill it.
        const fds = [child.stdout, child.stderr]
          .map((st) => (st as unknown as { _handle?: { fd?: number } } | null)?._handle?.fd)
          .filter((fd): fd is number => typeof fd === "number" && fd >= 0);
        const holders = await withinMs(outputPipeHolders(fds), CLEANUP_STEP_MS, [] as number[]);
        for (const pid of holders) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
        if (holders.length > 0)
          orphanNotes.push(
            `${holders.length} descendant process(es) outlived the check holding its output pipe and were killed`,
          );
        // Either the holders were just killed, or none was found (on a loaded host the
        // last output may simply still be in flight): give the pipes one more bounded
        // grace period before declaring them orphaned, so no output is lost.
        await new Promise<void>((res) => {
          const t = setTimeout(res, holders.length > 0 ? Math.min(grace, 1000) : grace);
          child.once("close", () => {
            clearTimeout(t);
            res();
          });
        });
      }
      if (open()) {
        orphanNotes.push(orphanNote);
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const finish of finishers) finish();
      }
      exitCode = child.exitCode;
      exitSignal = child.signalCode;
    }
    tracker?.stop();
    const orphaned = orphanNotes.length > 0;
    const orphanText = orphanNotes.join("; ");
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    signal?.removeEventListener("abort", onAbort);
    const maxRssBytes = sampler?.stop();
    await new Promise<void>((res) => (log ? log.end(() => res()) : res()));

    Object.assign(base, {
      exitCode,
      signal: exitSignal,
      outputTail: tail,
      outputBytes,
      truncated,
      secretFindings: redactors.reduce((n, r) => n + r.findings, 0),
    });
    const extra = {
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      ...(maxRssBytes !== undefined ? { maxRssBytes } : {}),
    };
    if (spawnError)
      return finish({
        state: "errored",
        reason: "spawn_error",
        error: spawnError.message,
        ...extra,
      });
    if (orphaned && outcome === undefined)
      return finish({
        state: "errored",
        reason: "orphaned_descendants",
        error: orphanText,
        ...extra,
      });
    if (outcome === "timed_out")
      return finish({
        state: "timed_out",
        reason: "timeout",
        error: `exceeded ${request.timeoutMs} ms${orphaned ? `; ${orphanText}` : ""}`,
        ...extra,
      });
    if (outcome === "cancelled")
      return finish({
        state: "cancelled",
        reason: "cancelled",
        ...(orphaned ? { error: orphanText } : {}),
        ...extra,
      });
    if (exitCode === 0) return finish({ state: "passed", ...extra });
    if (exitCode === null)
      return finish({
        state: "errored",
        error: `terminated by signal ${exitSignal ?? "unknown"}`,
        ...extra,
      });
    return finish({ state: "failed", ...extra });
  }
}
