import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore, type AppendInput, type EventStore } from "@mimir/core";
import { FakeRuntime } from "@mimir/fake-runtime";
import { newId, type RuntimeAdapter } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuildServerOptions } from "./index.js";

export const TOKEN = "test-token-0123456789";
export const AUTH = { authorization: `Bearer ${TOKEN}` };

export interface TestServer {
  app: FastifyInstance;
  store: EventStore;
  runtime: RuntimeAdapter | null;
  close(): Promise<void>;
}

export function makeServer(
  overrides: Partial<BuildServerOptions> = {},
  store: EventStore = openEventStore(":memory:"),
): TestServer {
  const runtime = overrides.runtime === undefined ? new FakeRuntime() : overrides.runtime;
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-server-data-")));
  const app = buildServer({
    store,
    ledger: store.commands,
    audit: store.audit,
    runtime,
    authToken: TOKEN,
    // app.inject() sends `Host: localhost:80`; real sockets are covered by the bound-port origins.
    publicOrigins: ["http://localhost:80"],
    tickMs: 0,
    dataDir,
    ...overrides,
  });
  return {
    app,
    store,
    runtime,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(`${dataDir}-worktrees`, { recursive: true, force: true });
    },
  };
}

/** A temp directory (realpath'd) holding an initialised git repo at `<dir>/repo`. */
export function tempGitRepo(): { dir: string; repo: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-server-")));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { dir, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function eventInput(overrides: Partial<AppendInput> = {}): AppendInput {
  const now = new Date().toISOString();
  return {
    streamId: "test",
    occurredAt: now,
    observedAt: now,
    type: "mission.created",
    source: "test",
    provenance: "observed",
    missionId: newId("msn"),
    payload: { projectId: newId("prj"), objective: "o" },
    ...overrides,
  };
}
