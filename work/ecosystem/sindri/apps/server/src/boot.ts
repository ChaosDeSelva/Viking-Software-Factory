import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EnvSecretStore, KeychainSecretStore, type SecretStore } from "@sindri/intake";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuildServerOptions } from "./app.js";
import { ensureAuthToken, loadConfig, type ServerConfig } from "./config.js";
import { serveWeb } from "./web.js";

/** Keychain on macOS unless `SINDRI_SECRET_STORE=env`; environment variables elsewhere. */
export function secretStoreFor(env: NodeJS.ProcessEnv): SecretStore {
  return process.platform === "darwin" && env["SINDRI_SECRET_STORE"] !== "env"
    ? new KeychainSecretStore()
    : new EnvSecretStore({ env });
}

export interface StartServerOptions {
  /** Serve this built web directory on the same origin (`sindri start`). */
  webDist?: string;
  logLevel?: string;
  /** Extra buildServer options (tests, demo). */
  overrides?: Partial<BuildServerOptions>;
}

export interface StartedServer {
  app: FastifyInstance;
  db: SqliteDatabase;
  config: ServerConfig;
  tokenPath: string;
  /** The origin actually bound (port 0 resolved). */
  url: string;
  close(): Promise<void>;
}

/**
 * Boots the server from env + `<dataDir>/config.json`: token, database, secret store,
 * `buildServer`, optional same-origin web, listen. Shared by `main.ts` and `sindri start`.
 */
export async function startServer(
  env: NodeJS.ProcessEnv,
  o: StartServerOptions = {},
): Promise<StartedServer> {
  const config = loadConfig(env);
  const { token, path: tokenPath } = ensureAuthToken(config.dataDir);
  const dbPath = join(config.dataDir, "sindri.db");
  const db = openDatabase(dbPath);
  const scheme = config.tls ? "https" : "http";
  const hostPart = config.host.includes(":") ? `[${config.host}]` : config.host;
  try {
    const app = buildServer({
      db,
      dbPath,
      dataDir: config.dataDir,
      authToken: token,
      secrets: secretStoreFor(env),
      attachmentsDir: join(config.dataDir, "attachments"),
      allowedOrigins: [
        ...config.allowedOrigins,
        // The web app is same-origin when served here.
        ...(o.webDist ? [`${scheme}://${hostPart}:${config.port}`] : []),
      ],
      allowRemote: config.allowRemote,
      logLevel: o.logLevel ?? env["SINDRI_LOG_LEVEL"] ?? "info",
      ...(config.tls
        ? {
            https: {
              cert: readFileSync(config.tls.certPath),
              key: readFileSync(config.tls.keyPath),
            },
          }
        : {}),
      ...o.overrides,
    });
    if (o.webDist) serveWeb(app, o.webDist);
    await app.listen({ host: config.host, port: config.port });
    const addr = app.server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : config.port;
    return {
      app,
      db,
      config,
      tokenPath,
      url: `${scheme}://${hostPart}:${port}`,
      async close() {
        await app.close();
        db.close();
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
