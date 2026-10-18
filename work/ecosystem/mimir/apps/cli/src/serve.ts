import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT_CONFIG, EXIT_INFRA, dataDir } from "./env.js";

/** The server entry shipped next to the CLI: `apps/server/dist` in the repo, `app/server/dist` in a release. */
export const SERVER_MAIN = fileURLToPath(new URL("../../server/dist/main.js", import.meta.url));
/** The built web app, laid out the same way (`apps/web/dist` / `app/web/dist`). */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist", import.meta.url));

const RUNTIMES = ["fake", "herdr", "cli", "none"] as const;

export function checkRuntime(runtime: string | undefined): void {
  if (runtime !== undefined && !(RUNTIMES as readonly string[]).includes(runtime)) {
    throw new CliError(`--runtime must be one of ${RUNTIMES.join(", ")}`, EXIT_CONFIG);
  }
}

/** Host and port from `<data>/config.json` (written by `mimir init`) as server env defaults. */
function configDefaults(env: NodeJS.ProcessEnv): Record<string, string> {
  const path = join(dataDir(env), "config.json");
  if (!existsSync(path)) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliError(`cannot read ${path}: ${(e as Error).message}`, EXIT_CONFIG);
  }
  const out: Record<string, string> = {};
  if (cfg !== null && typeof cfg === "object") {
    const { host, port } = cfg as { host?: unknown; port?: unknown };
    if (typeof host === "string" && host !== "") out["MIMIR_HOST"] = host;
    if (typeof port === "number" && Number.isInteger(port)) out["MIMIR_PORT"] = String(port);
  }
  return out;
}

export interface ServerOptions {
  runtime?: string | undefined;
  /** Skip config.json (the demo uses its own isolated data dir). */
  ignoreConfig?: boolean;
  extraEnv?: Record<string, string>;
}

export interface ServerProcess {
  child: ChildProcess;
  /** Resolves with the bound URL once the server announces it; rejects if it exits first. */
  url: Promise<string>;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number>;
  stop(): void;
}

/** Spawns the Mimir server as a child process, serving the web app when it is built. */
export function spawnServer(
  env: NodeJS.ProcessEnv,
  opts: ServerOptions,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
): ServerProcess {
  if (!existsSync(SERVER_MAIN)) {
    throw new CliError(`server not found at ${SERVER_MAIN}; run \`pnpm build\``, EXIT_INFRA);
  }
  const childEnv: NodeJS.ProcessEnv = { ...(opts.ignoreConfig ? {} : configDefaults(env)) };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") childEnv[k] = v;
  if (opts.runtime !== undefined) childEnv["MIMIR_RUNTIME"] = opts.runtime;
  Object.assign(childEnv, opts.extraEnv);

  const webRoot = childEnv["MIMIR_WEB_ROOT"] ?? DEFAULT_WEB_ROOT;
  if (existsSync(join(webRoot, "index.html"))) childEnv["MIMIR_WEB_ROOT"] = webRoot;
  else {
    delete childEnv["MIMIR_WEB_ROOT"];
    process.stderr.write(
      `mimir: web app not found at ${webRoot}; serving the API only (run \`pnpm build\`)\n`,
    );
  }

  const child = spawn(process.execPath, [SERVER_MAIN], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveUrl!: (u: string) => void;
  let rejectUrl!: (e: Error) => void;
  const url = new Promise<string>((res, rej) => ((resolveUrl = res), (rejectUrl = rej)));
  url.catch(() => undefined);
  const exited = new Promise<number>((res) => {
    child.on("exit", (code, signal) => res(code ?? (signal ? 1 : 0)));
    child.on("error", () => res(1));
  });
  void exited.then((code) => rejectUrl(new Error(`server exited with code ${code}`)));
  for (const stream of ["stdout", "stderr"] as const) {
    let buf = "";
    child[stream]?.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /listening on (https?:\/\/\S+)/.exec(line);
        if (m) resolveUrl(m[1] as string);
        onLine(line, stream);
      }
    });
  }
  return { child, url, exited, stop: () => void child.kill("SIGTERM") };
}

/** Runs the server in the foreground, forwarding its output and signals; returns its exit code. */
export async function runServer(env: NodeJS.ProcessEnv, opts: ServerOptions): Promise<number> {
  const server = spawnServer(env, opts, (line, stream) =>
    (stream === "stdout" ? process.stdout : process.stderr).write(line + "\n"),
  );
  const forward = () => server.stop();
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const code = await server.exited;
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  return code === 0 ? 0 : EXIT_INFRA;
}
