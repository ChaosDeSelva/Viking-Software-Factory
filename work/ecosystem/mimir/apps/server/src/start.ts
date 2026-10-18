import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openEventStore, type EventStore } from "@mimir/core";
import { SshRuntime } from "./ssh-runtime/adapter.js";
import { TerminalRuntime } from "./terminal-runtime/adapter.js";
import { NativeTerminalBackend, type BackendName } from "./terminal-runtime/backend.js";
import { loadFleet } from "./fleet-runtime/config.js";
import { CliRuntime } from "./cli-runtime/adapter.js";
import { FakeRuntime } from "@mimir/fake-runtime";
import { HerdrAdapter, JsonFileBindingStore } from "@mimir/herdr-adapter";
import type { RuntimeAdapter } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import {
  ensureAuthToken,
  loadConfig,
  type AuthTokenInfo,
  type Env,
  type ServerConfig,
} from "./config.js";
import { buildServer } from "./index.js";
import { createLogger } from "./logger.js";
import { selectVerifier } from "./orchestrator/verifier-select.js";

export interface StartedMimir {
  app: FastifyInstance;
  store: EventStore;
  runtime: RuntimeAdapter | null;
  logger: Logger;
  config: ServerConfig;
  auth: AuthTokenInfo;
  /** Base URL at the address and port actually bound (`MIMIR_PORT=0` picks a free port). */
  url: string;
  /** Stops accepting requests, disposes the runtime and closes the store (releasing its lock). */
  close(): Promise<void>;
}

/**
 * Boots a server from environment config: data dir and token, the event store (single-writer
 * lock), the runtime, and `buildServer`, then listens. Used by `main.ts`.
 */
export async function startMimir(env: Env): Promise<StartedMimir> {
  const config = loadConfig(env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const auth = ensureAuthToken(config);
  const logger = createLogger({ level: env["MIMIR_LOG_LEVEL"] ?? "info" });
  const store = openEventStore(config.dbPath, {
    onCorruptRow: (row) => logger.error({ row }, "refused corrupt event row"),
  });
  const fake = config.runtime === "fake" ? new FakeRuntime() : null;
  // The fake runtime runs on a manual clock; drive it in real time for demos.
  const fakeTimer = fake ? setInterval(() => fake.clock.advance(100), 100) : null;
  fakeTimer?.unref();
  let runtime: RuntimeAdapter | null = null;
  let app: FastifyInstance;
  try {
    runtime =
      fake !== null
        ? fake
        : ["tmux-interactive", "zellij", "cmux", "orca"].includes(config.runtime)
          ? new TerminalRuntime(
              new NativeTerminalBackend(
                config.runtime as BackendName,
                join(config.dataDir, "terminals"),
              ),
              join(config.dataDir, "terminals"),
            )
          : config.runtime === "fleet"
            ? loadFleet(env["MIMIR_FLEET_CONFIG"] ?? "", config.dataDir)
            : config.runtime === "cli"
              ? new CliRuntime()
              : config.runtime === "tmux"
                ? new CliRuntime({}, "tmux")
                : config.runtime === "ssh"
                  ? new SshRuntime(
                      { host: env["MIMIR_SSH_HOST"] ?? "", root: env["MIMIR_SSH_ROOT"] ?? "" },
                      join(config.dataDir, "ssh-bindings.json"),
                    )
                  : config.runtime === "herdr"
                    ? new HerdrAdapter({
                        bindings: new JsonFileBindingStore(
                          join(config.dataDir, "herdr-bindings.json"),
                        ),
                      })
                    : null;
    // Brokkr when the vendored @brokkr/sdk loads, else the test-command verifier (logged).
    const verifier = await selectVerifier({ log: logger, dataDir: config.dataDir });
    app = buildServer({
      verifier,
      store,
      ledger: store.commands,
      audit: store.audit,
      runtime,
      runtimeReportsUsage: config.runtime === "cli" || config.runtime === "tmux",
      authToken: auth.token,
      logger,
      allowedOrigins: config.allowedOrigins,
      publicOrigins: config.publicOrigins,
      allowedRoots: config.allowedRoots,
      dataDir: config.dataDir,
      worktreeRoot: config.worktreeRoot,
      tickMs: config.tickMs,
      artifactRetentionDays: config.artifactRetentionDays,
      maxArtifactBytes: config.maxArtifactBytes,
      ...(config.webRoot !== null ? { webRoot: config.webRoot } : {}),
      ...(config.approvalTtlMs !== null ? { approvalTtlMs: config.approvalTtlMs } : {}),
      ...(config.tls
        ? {
            https: {
              cert: readFileSync(config.tls.certPath),
              key: readFileSync(config.tls.keyPath),
            },
          }
        : {}),
    });
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    if (fakeTimer) clearInterval(fakeTimer);
    await runtime?.dispose();
    store.close();
    throw err;
  }
  const address = app.server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;
  const scheme = config.tls ? "https" : "http";
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const started = app;
  return {
    app,
    store,
    runtime,
    logger,
    config,
    auth,
    url: `${scheme}://${host}:${port}`,
    close: async () => {
      try {
        if (fakeTimer) clearInterval(fakeTimer);
        await started.close();
        await runtime?.dispose();
      } finally {
        store.close();
      }
    },
  };
}
