import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT_INFRA, tokenPath } from "./env.js";
import { spawnServer, type ServerOptions } from "./serve.js";

/** Loosely typed API JSON; the demo only reads ids. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** On the default command allowlist (ADR-014) and passing: the repo's `test` script exits 0. */
export const DEMO_TEST_COMMAND = ["npm", "test"];

function makeRepo(repo: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      stdio: "ignore",
      env: { PATH: env["PATH"] ?? "", HOME: env["HOME"] ?? "", GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      { name: "mimir-demo", private: true, scripts: { test: "node -e 'process.exit(0)'" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(repo, "README.md"), "# mimir demo repository\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Mimir Demo",
    "-c",
    "user.email=demo@mimir.invalid",
    "commit",
    "-q",
    "-m",
    "init",
  );
}

export interface DemoResult {
  exitCode: number;
}

/**
 * Starts a server on the fake runtime in a throwaway data dir, creates a project (passing
 * `testCommand`), a mission with three dependent tasks and a shell crew, and prints how to reach
 * it. Nothing is approved on the user's behalf. Runs until interrupted, then removes everything.
 */
export async function runDemo(
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-demo-")));
  const data = join(root, "data");
  const repo = join(root, "repo");
  let server: ReturnType<typeof spawnServer> | null = null;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    server?.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    makeRepo(repo, env);
    const opts: ServerOptions = {
      ignoreConfig: true,
      runtime: "fake",
      extraEnv: { MIMIR_DATA_DIR: data, MIMIR_RUNTIME: "fake", MIMIR_ALLOWED_ROOTS: "" },
    };
    server = spawnServer({ ...env, MIMIR_AUTH_TOKEN: "" }, opts, (line, stream) => {
      if (stream === "stderr") err(line);
    });
    const url = await server.url;
    const token = readFileSync(tokenPath(data), "utf8").trim();
    let n = 0;
    const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `demo-${++n}-${Date.now()}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok)
        throw new CliError(`demo setup: ${method} ${path} -> ${res.status} ${text}`, EXIT_INFRA);
      return text === "" ? null : JSON.parse(text);
    };
    const project = await call("POST", "/v1/projects", {
      name: "mimir-demo",
      repoPath: repo,
      settings: { testCommand: DEMO_TEST_COMMAND },
    });
    const mission = await call("POST", "/v1/missions", {
      projectId: project.project.id,
      objective: "Demo: three dependent shell tasks on the fake runtime",
      tasks: [{ title: "Write the greeting", brief: "echo hello from mimir" }],
    });
    const missionId = mission.mission.id as string;
    const first = mission.tasks[0].id as string;
    const second = await call("POST", "/v1/tasks", {
      missionId,
      title: "Count the files",
      brief: "ls | wc -l",
      dependsOn: [first],
    });
    await call("POST", "/v1/tasks", {
      missionId,
      title: "Print the date",
      brief: "date",
      dependsOn: [second.task.id],
    });
    await call("POST", "/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxConcurrentTasks: 1 },
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    await call("POST", `/v1/missions/${missionId}/start`, {});
    out("mimir demo (fake runtime, temporary data; nothing is auto-approved)");
    out(`url: ${url}`);
    out(`mission: ${missionId}`);
    out(`token file: ${tokenPath(data)}`);
    out(
      "paste the token into the web app; decide any approvals yourself. Ctrl-C to stop and clean up.",
    );
    const code = await server.exited;
    return interrupted || code === 0 ? 0 : EXIT_INFRA;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    server?.stop();
    if (server)
      await Promise.race([server.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    rmSync(root, { recursive: true, force: true });
  }
}
