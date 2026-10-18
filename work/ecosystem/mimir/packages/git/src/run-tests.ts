import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { MimirError } from "@mimir/protocol";
import { assertSafeAbsolutePath } from "./paths.js";

/** Per-stream output cap. */
export const OUTPUT_CAP_BYTES = 1024 * 1024;
export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Variables copied from the parent environment. Nothing else is inherited. */
export const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM"] as const;

export interface RunTestsOptions {
  timeoutMs?: number;
  /** Explicit extra variables passed to the command (on top of the allowlist). */
  env?: Record<string, string>;
}

export interface RunTestsResult {
  /** Process exit code; `null` when killed by a signal (e.g. on timeout); 127 if not spawnable. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** True when either stream exceeded {@link OUTPUT_CAP_BYTES} and was cut. */
  truncated: boolean;
}

export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...extra };
}

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  push(chunk: Buffer): void {
    const room = OUTPUT_CAP_BYTES - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }
  toString(): string {
    const buf = Buffer.concat(this.chunks);
    return (this.truncated ? buf.subarray(0, utf8Boundary(buf)) : buf).toString("utf8");
  }
}

/** Length of `buf` with any incomplete trailing UTF-8 sequence removed. */
function utf8Boundary(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const byte = buf[buf.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

/**
 * Runs a test command (argument array, never a shell string) in a worktree with a scrubbed
 * environment, a timeout and capped output. The command runs in its own process group so the
 * whole tree is killed on timeout.
 */
export async function runTests(
  worktreePath: string,
  command: string[],
  options: RunTestsOptions = {},
): Promise<RunTestsResult> {
  const cwd = assertSafeAbsolutePath(worktreePath, "worktreePath");
  const [file, ...args] = command;
  if (!file) throw new MimirError("validation_failed", "command must not be empty");
  const st = await stat(cwd).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new MimirError("not_found", "worktreePath does not exist", { path: cwd });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MimirError("validation_failed", "timeoutMs must be a finite number > 0", {
      timeoutMs,
    });
  }
  const started = performance.now();
  const out = new CappedBuffer();
  const err = new CappedBuffer();

  return await new Promise<RunTestsResult>((resolve) => {
    let timedOut = false;
    let spawnError: Error | undefined;
    const child = spawn(file, args, {
      cwd,
      env: scrubbedEnv(options.env),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTree = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // A descendant that escaped the process group could hold the pipes open; stop waiting.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 2000).unref();
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      spawnError = e;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      if (spawnError) {
        resolve({
          exitCode: 127,
          signal: null,
          stdout: out.toString(),
          stderr: `${err.toString()}${spawnError.message}`,
          durationMs,
          timedOut: false,
          truncated: out.truncated || err.truncated,
        });
        return;
      }
      resolve({
        exitCode: code,
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        durationMs,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
