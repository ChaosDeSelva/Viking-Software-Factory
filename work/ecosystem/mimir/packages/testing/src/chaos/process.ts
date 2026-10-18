import { spawn, type ChildProcess } from "node:child_process";

/** Auth token the chaos helpers give every spawned server (MIMIR_AUTH_TOKEN needs >= 32 chars). */
export const CHAOS_TOKEN = "chaos-token-0123456789abcdef0123456789";

const READY = /listening on (https?:\/\/\S+)/;

export interface SpawnMimirOptions {
  /** Absolute path of the entry module (`apps/server/src/main.ts` or a chaos fixture). */
  entry: string;
  dataDir: string;
  /** Extra node flags, e.g. `["--import", tsxLoaderUrl]` to run TypeScript sources. */
  nodeArgs?: readonly string[];
  /** Overrides on top of the defaults (`MIMIR_HOST=127.0.0.1`, `MIMIR_PORT=0`, token, data dir). */
  env?: Record<string, string>;
  cwd?: string;
  token?: string;
  /** How long to wait for the "listening on" line. Default 20 s. */
  readyTimeoutMs?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface MimirProcess {
  url: string;
  token: string;
  pid: number;
  child: ChildProcess;
  /** Everything written to stdout and stderr so far. */
  output(): string;
  /** Resolves with the first output line matching `re` (already printed or future). */
  waitForLine(re: RegExp, timeoutMs?: number): Promise<string>;
  /** Sends `signal` (default SIGKILL) and resolves once the process is gone. */
  kill(signal?: NodeJS.Signals): Promise<ExitInfo>;
  exited: Promise<ExitInfo>;
}

function childEnv(opts: SpawnMimirOptions): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("MIMIR_")),
  );
  return {
    ...base,
    MIMIR_HOST: "127.0.0.1",
    MIMIR_PORT: "0",
    MIMIR_DATA_DIR: opts.dataDir,
    MIMIR_AUTH_TOKEN: opts.token ?? CHAOS_TOKEN,
    MIMIR_LOG_LEVEL: "warn",
    ...opts.env,
  };
}

interface Running {
  child: ChildProcess;
  output: () => string;
  waitForLine: (re: RegExp, timeoutMs?: number) => Promise<string>;
  exited: Promise<ExitInfo>;
}

function start(opts: SpawnMimirOptions): Running {
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), opts.entry], {
    cwd: opts.cwd ?? process.cwd(),
    env: childEnv(opts),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  const waiters = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    text += chunk.toString("utf8");
    for (const w of [...waiters]) w();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  let done = false;
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      done = true;
      // Let buffered output drain before reporting the exit.
      setImmediate(() => {
        for (const w of [...waiters]) w();
        resolve({ code, signal });
      });
    });
  });
  const waitForLine = (re: RegExp, timeoutMs = 20_000) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const line = text.split("\n").find((l) => re.test(l));
        if (line !== undefined) {
          finish();
          resolve(line);
        } else if (done) {
          finish();
          reject(new Error(`process exited before printing ${re}:\n${text}`));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`no output matching ${re} within ${timeoutMs}ms:\n${text}`));
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      waiters.add(check);
      check();
    });
  return { child, output: () => text, waitForLine, exited };
}

/** Spawns a server process and resolves once it printed `listening on <url>`. */
export async function spawnMimir(opts: SpawnMimirOptions): Promise<MimirProcess> {
  const r = start(opts);
  let url: string;
  try {
    const ready = await r.waitForLine(READY, opts.readyTimeoutMs ?? 20_000).catch(async (err) => {
      if (r.child.exitCode === null && r.child.signalCode === null) throw err;
      const e = await r.exited;
      throw new Error(
        `server exited (code ${e.code}, signal ${e.signal}) before it was ready:\n${r.output()}`,
      );
    });
    url = (READY.exec(ready) as RegExpExecArray)[1] as string;
  } catch (err) {
    r.child.kill("SIGKILL");
    await r.exited;
    throw err;
  }
  return {
    url,
    token: opts.token ?? CHAOS_TOKEN,
    pid: r.child.pid as number,
    child: r.child,
    output: r.output,
    waitForLine: r.waitForLine,
    exited: r.exited,
    kill: async (signal = "SIGKILL") => {
      if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill(signal);
      return r.exited;
    },
  };
}

/** Runs a server process that is expected to refuse to start; resolves with its exit. */
export async function runMimirToExit(
  opts: SpawnMimirOptions & { timeoutMs?: number },
): Promise<ExitInfo & { output: string }> {
  const r = start(opts);
  const timer = setTimeout(() => r.child.kill("SIGKILL"), opts.timeoutMs ?? 20_000);
  const exit = await r.exited;
  clearTimeout(timer);
  return { ...exit, output: r.output() };
}
