import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Locates a built Mimir server (`mimir/apps/server/dist/main.js`) next to this repo: the
 * `SINDRI_ACCEPTANCE_MIMIR_MAIN` override, else the first ancestor directory with a sibling
 * `mimir/` checkout. Mimir is used only as a separate process (no source imports).
 */
export function findMimirMain(start = process.cwd()): string | null {
  const override = process.env["SINDRI_ACCEPTANCE_MIMIR_MAIN"];
  if (override) return existsSync(override) ? resolve(override) : null;
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, "mimir", "apps", "server", "dist", "main.js");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

export interface MimirChild {
  url: string;
  token: string;
  verification: { harnesses: string[]; lockPath: string };
  proc: ChildProcess;
  output: () => string;
  /** GET/POST against Mimir's HTTP API with the bearer token. */
  api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

/**
 * Starts Mimir as a child process on an ephemeral loopback port with the fake agent runtime
 * (`MIMIR_RUNTIME=fake`, see mimir T12/T15 reports), a temp data dir and a known token.
 */
export async function startMimirChild(main: string, dataDir: string): Promise<MimirChild> {
  const token = randomBytes(32).toString("hex");
  let out = "";
  const proc = spawn(
    process.execPath,
    ["--import", fileURLToPath(new URL("./fixture-agent.mjs", import.meta.url)), main],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: dataDir,
        MIMIR_DATA_DIR: dataDir,
        MIMIR_WORKTREE_ROOT: `${dataDir}-worktrees`,
        SINDRI_ACCEPTANCE_MIMIR_MAIN: main,
        MIMIR_RUNTIME: "fake",
        MIMIR_PORT: "0",
        MIMIR_AUTH_TOKEN: token,
        MIMIR_TICK_MS: "100",
        MIMIR_LOG_LEVEL: "warn",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`Mimir did not start:\n${out}`)), 30_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = /mimir server listening on (\S+)/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        ok(m[1]);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (b: Buffer) => (out += b.toString()));
    proc.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Mimir exited with ${code}:\n${out}`));
    });
  });
  return {
    url,
    token,
    verification: {
      harnesses: ["qa-regression@^1"],
      lockPath: join(dataDir, "acceptance.lock.json"),
    },
    proc,
    output: () => out,
    async api<T>(path: string, body?: unknown): Promise<T> {
      const res = await fetch(new URL(path, url), {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": randomBytes(16).toString("hex"),
        },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`Mimir GET ${path}: HTTP ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    },
    async close() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}
