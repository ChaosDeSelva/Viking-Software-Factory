import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  allowRemote: boolean;
  allowedOrigins: string[];
  tls?: { certPath: string; keyPath: string };
}

export const DEFAULT_PORT = 7800;
export const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:5173";
/** Both loopback spellings of the web dev server. */
export const DEFAULT_WEB_ORIGINS = [DEFAULT_WEB_ORIGIN, "http://localhost:5173"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export const isLoopbackHost = (host: string) => LOOPBACK.has(host);

/** Keys `sindri init` writes to `<dataDir>/config.json`; the environment overrides each one. */
export interface ConfigFile {
  host?: string;
  port?: number;
  allowedOrigins?: string[];
}

/** `<SINDRI_DATA_DIR or $HOME/.sindri>`. */
export function dataDirFrom(env: Record<string, string | undefined>): string {
  return env["SINDRI_DATA_DIR"] || join(env["HOME"] || homedir(), ".sindri");
}

/** Reads `<dataDir>/config.json` if present. Unknown keys are ignored; bad values throw. */
export function readConfigFile(dataDir: string): ConfigFile {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Invalid ${path}: ${(e as Error).message}`, { cause: e });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`Invalid ${path}: expected a JSON object`);
  const o = raw as Record<string, unknown>;
  const out: ConfigFile = {};
  if (o["host"] !== undefined) {
    if (typeof o["host"] !== "string" || o["host"] === "")
      throw new Error(`Invalid host in ${path}`);
    out.host = o["host"];
  }
  if (o["port"] !== undefined) {
    const p = o["port"];
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535)
      throw new Error(`Invalid port in ${path}: ${JSON.stringify(p)}`);
    out.port = p;
  }
  if (o["allowedOrigins"] !== undefined) {
    const a = o["allowedOrigins"];
    if (!Array.isArray(a) || !a.every((x) => typeof x === "string"))
      throw new Error(`Invalid allowedOrigins in ${path}: expected an array of strings`);
    out.allowedOrigins = a as string[];
  }
  return out;
}

/**
 * Resolve server config: environment first, then `<dataDir>/config.json`, then defaults.
 * Non-loopback binds need opt-in plus TLS, wherever the host came from.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const dataDir = dataDirFrom(env);
  const file = readConfigFile(dataDir);
  const host = env["SINDRI_HOST"] || file.host || "127.0.0.1";
  const rawPort = env["SINDRI_PORT"];
  let port = file.port ?? DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== "") {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid SINDRI_PORT: ${rawPort}`);
  }
  const allowRemote = env["SINDRI_ALLOW_REMOTE"] === "1";
  const certPath = env["SINDRI_TLS_CERT"];
  const keyPath = env["SINDRI_TLS_KEY"];
  const tls = certPath && keyPath ? { certPath, keyPath } : undefined;
  if (!isLoopbackHost(host)) {
    if (!allowRemote)
      throw new Error(
        `Refusing non-loopback ${env["SINDRI_HOST"] ? "SINDRI_HOST" : "config.json host"} ${host} without SINDRI_ALLOW_REMOTE=1`,
      );
    if (!tls)
      throw new Error(
        "A non-loopback SINDRI_HOST requires TLS (SINDRI_TLS_CERT and SINDRI_TLS_KEY)",
      );
  }
  const origins = (env["SINDRI_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins =
    origins.length > 0 ? origins : (file.allowedOrigins ?? [...DEFAULT_WEB_ORIGINS]);
  for (const origin of allowedOrigins) {
    const u = new URL(origin);
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.origin !== origin ||
      (!allowRemote && !isLoopbackHost(u.hostname.replace(/^\[|\]$/g, "")))
    )
      throw new Error(`Invalid allowedOrigins entry: ${origin}`);
  }
  return {
    host,
    port,
    dataDir,
    allowRemote,
    allowedOrigins,
    ...(tls ? { tls } : {}),
  };
}

const MIN_TOKEN_LENGTH = 32;

/** Read `<dataDir>/auth-token`, creating it (0600, dir 0700) with 32 random bytes if absent. */
export function ensureAuthToken(dataDir: string): { token: string; path: string } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (statSync(dataDir).mode & 0o077) chmodSync(dataDir, 0o700);
  const path = join(dataDir, "auth-token");
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= MIN_TOKEN_LENGTH) {
      if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
      return { token, path };
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, path };
}
