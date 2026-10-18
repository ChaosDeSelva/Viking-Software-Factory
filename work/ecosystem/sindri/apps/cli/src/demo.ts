import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import {
  buildServer,
  ensureAuthToken,
  loadConfig,
  secretStoreFor,
  writeDemoRepo,
} from "@sindri/server";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";

export interface DemoResult {
  repoPath: string;
  ticketPath: string;
  projectId: string;
  intakeId: string;
  failingTest: string | null;
  bootstrap: { indexed: number; skipped: number };
  url: string;
}

export interface DemoOptions {
  /** Parent directory for the demo (must be absent or empty). Default: a new temp dir. */
  dir?: string;
  /** Plant one failing test (fails once, see writeDemoRepo). */
  failingTest?: boolean;
}

/**
 * `sindri demo`: a sample full-stack repo, a project for it, a bootstrap index and the fixture
 * ticket as a manual intake, all through the server's own API (in-process, no listener, no
 * resume of other executions). Prints where to look once `sindri start` runs.
 */
export async function demo(
  o: DemoOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DemoResult> {
  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    throw new CliError((e as Error).message, EXIT_CONFIG);
  }
  let root: string;
  if (o.dir) {
    root = resolve(o.dir);
    if (existsSync(root) && readdirSync(root).length > 0)
      throw new CliError(`${root} is not empty; pick a new --dir`, EXIT_CONFIG);
    mkdirSync(root, { recursive: true });
  } else root = mkdtempSync(join(tmpdir(), "sindri-demo-"));

  const { token } = ensureAuthToken(config.dataDir);
  const db = openDatabase(join(config.dataDir, "sindri.db"));
  const app = buildServer({
    db,
    dataDir: config.dataDir,
    authToken: token,
    secrets: secretStoreFor(env),
    attachmentsDir: join(config.dataDir, "attachments"),
    resumeOnReady: false,
  });
  let n = 0;
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        host: "127.0.0.1",
        ...(method === "POST" ? { "idempotency-key": `sindri-demo-${Date.now()}-${++n}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    if (res.statusCode >= 300) {
      const err = (res.json() as { error?: { message?: string } }).error?.message ?? res.body;
      throw new CliError(`demo: ${method} ${url} failed (${res.statusCode}): ${err}`, EXIT_INFRA);
    }
    return res.json() as Record<string, unknown>;
  };
  try {
    const repo = writeDemoRepo(root, { failingTest: o.failingTest === true });
    const { project } = (await call("POST", "/v1/projects", {
      name: "Reports demo",
      repoPath: repo.repoPath,
    })) as { project: { id: string } };
    const { result } = (await call("POST", `/v1/projects/${project.id}/bootstrap`, {})) as {
      result: { indexed: string[]; skipped: unknown[] };
    };
    const ticket = JSON.parse(readFileSync(repo.ticketPath, "utf8")) as {
      title: string;
      body: string;
    };
    const { intake } = (await call("POST", "/v1/intakes", {
      projectId: project.id,
      title: ticket.title,
      body: ticket.body,
    })) as { intake: { id: string } };
    const scheme = config.tls ? "https" : "http";
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    return {
      repoPath: repo.repoPath,
      ticketPath: repo.ticketPath,
      projectId: project.id,
      intakeId: intake.id,
      failingTest: repo.failingTest,
      bootstrap: { indexed: result.indexed.length, skipped: result.skipped.length },
      url: `${scheme}://${host}:${config.port}/#/inbox?project=${project.id}`,
    };
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`demo failed: ${(e as Error).message}`, EXIT_INFRA);
  } finally {
    await app.close();
    db.close();
  }
}
