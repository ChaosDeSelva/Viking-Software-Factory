import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  statSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isIP } from "node:net";

export type Env = Record<string, string | undefined>;

export interface TlsPaths {
  certPath: string;
  keyPath: string;
}

export interface ListenOptions {
  host: string;
  port: number;
  /** Set only for a remote bind (`MIMIR_ALLOW_REMOTE=1`). */
  tls: TlsPaths | null;
}

export type RuntimeChoice =
  | "fake"
  | "herdr"
  | "cli"
  | "ssh"
  | "tmux"
  | "fleet"
  | "tmux-interactive"
  | "zellij"
  | "cmux"
  | "orca"
  | "none";
const RUNTIMES: readonly RuntimeChoice[] = [
  "fake",
  "herdr",
  "cli",
  "ssh",
  "tmux",
  "fleet",
  "tmux-interactive",
  "zellij",
  "cmux",
  "orca",
  "none",
];

export interface ServerConfig extends ListenOptions {
  /** Mimir's private state (0700): event store and operator token. Never agent-reachable. */
  dataDir: string;
  /**
   * Where agent worktrees live (`MIMIR_WORKTREE_ROOT`, default `~/.mimir-work/worktrees`).
   * Always outside `dataDir`, so an agent's cwd never sits next to the operator token (audit H1).
   */
  worktreeRoot: string;
  dbPath: string;
  authTokenPath: string;
  /** `MIMIR_AUTH_TOKEN`, when set; otherwise the token lives in `authTokenPath`. */
  authTokenEnv: string | null;
  allowedOrigins: string[];
  /** Origins this server is reached at; used for Host/Origin checks (see buildServer). */
  publicOrigins: string[];
  /** Empty means "no restriction" on project repo paths. */
  allowedRoots: string[];
  runtime: RuntimeChoice;
  /** `MIMIR_TICK_MS`: orchestrator tick interval (0 disables the loop). */
  tickMs: number;
  /** `MIMIR_ARTIFACT_RETENTION_DAYS`. */
  artifactRetentionDays: number;
  /** `MIMIR_APPROVAL_TTL_MS`; null = server default. */
  approvalTtlMs: number | null;
  /** `MIMIR_MAX_ARTIFACT_BYTES`: largest artifact served over HTTP. */
  maxArtifactBytes: number;
  /** `MIMIR_WEB_ROOT`: built web app directory to serve from the API origin; null = API only. */
  webRoot: string | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7700;

/** The web dev server (Vite) origins allowed by default for CSRF checks. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];

const nonEmpty = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === "" ? undefined : v.trim();

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("::ffff:127.");
  return false;
}

/**
 * Host/port/TLS from the environment. Binding to a non-loopback address is refused unless
 * `MIMIR_ALLOW_REMOTE=1` and both `MIMIR_TLS_CERT` and `MIMIR_TLS_KEY` are set.
 */
export function resolveListenOptions(env: Env): ListenOptions {
  const host = nonEmpty(env["MIMIR_HOST"]) ?? DEFAULT_HOST;
  const raw = nonEmpty(env["MIMIR_PORT"]);
  let port = DEFAULT_PORT;
  if (raw !== undefined) {
    port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid MIMIR_PORT: ${raw}`);
    }
  }
  if (isLoopbackHost(host)) return { host, port, tls: null };

  const cert = nonEmpty(env["MIMIR_TLS_CERT"]);
  const key = nonEmpty(env["MIMIR_TLS_KEY"]);
  if (env["MIMIR_ALLOW_REMOTE"] !== "1") {
    throw new Error(
      `Refusing to bind to non-loopback host ${host}: set MIMIR_ALLOW_REMOTE=1 and MIMIR_TLS_CERT/MIMIR_TLS_KEY`,
    );
  }
  if (cert === undefined || key === undefined) {
    throw new Error(
      `Refusing to bind to non-loopback host ${host} without TLS: set MIMIR_TLS_CERT and MIMIR_TLS_KEY`,
    );
  }
  return { host, port, tls: { certPath: cert, keyPath: key } };
}

const splitList = (raw: string | undefined, sep: RegExp): string[] | undefined => {
  const v = nonEmpty(raw);
  return v === undefined
    ? undefined
    : v
        .split(sep)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
};

export const MIN_AUTH_TOKEN_LENGTH = 32;

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Origins derived from the listen address: loopback aliases, or the configured remote host. */
function derivePublicOrigins(listen: ListenOptions): string[] {
  const scheme = listen.tls ? "https" : "http";
  if (isLoopbackHost(listen.host)) {
    return ["127.0.0.1", "localhost", "[::1]"].map((h) => `${scheme}://${h}:${listen.port}`);
  }
  if (WILDCARD_HOSTS.has(listen.host)) {
    throw new Error(
      `MIMIR_HOST=${listen.host} binds every interface: set MIMIR_PUBLIC_ORIGINS to the origin(s) clients use`,
    );
  }
  const host = listen.host.includes(":") ? `[${listen.host}]` : listen.host;
  return [`${scheme}://${host}:${listen.port}`];
}

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function numberFrom(env: Env, name: string, min: number, fallback: number): number;
function numberFrom(env: Env, name: string, min: number, fallback: null): number | null;
function numberFrom(env: Env, name: string, min: number, fallback: number | null): number | null {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n) || n < min) {
    throw new Error(`Invalid ${name}: ${raw} (expected a number >= ${min})`);
  }
  return n;
}

export function loadConfig(env: Env, home: string = homedir()): ServerConfig {
  const listen = resolveListenOptions(env);
  const dataDir = resolve(nonEmpty(env["MIMIR_DATA_DIR"]) ?? join(home, ".mimir"));
  const worktreeRoot = resolve(
    nonEmpty(env["MIMIR_WORKTREE_ROOT"]) ?? join(home, ".mimir-work", "worktrees"),
  );
  if (isInside(worktreeRoot, dataDir)) {
    throw new Error(
      `MIMIR_WORKTREE_ROOT (${worktreeRoot}) must not be inside the data dir (${dataDir}): it holds the operator token`,
    );
  }
  const runtime = nonEmpty(env["MIMIR_RUNTIME"]) ?? "fake";
  if (!(RUNTIMES as readonly string[]).includes(runtime)) {
    throw new Error(`Invalid MIMIR_RUNTIME: ${runtime} (expected one of ${RUNTIMES.join(", ")})`);
  }
  const authTokenEnv = nonEmpty(env["MIMIR_AUTH_TOKEN"]) ?? null;
  if (authTokenEnv !== null && authTokenEnv.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`MIMIR_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters`);
  }
  return {
    ...listen,
    dataDir,
    worktreeRoot,
    dbPath: join(dataDir, "mimir.db"),
    authTokenPath: join(dataDir, "auth-token"),
    authTokenEnv,
    allowedOrigins: splitList(env["MIMIR_ALLOWED_ORIGINS"], /,/) ?? [...DEFAULT_ALLOWED_ORIGINS],
    publicOrigins: splitList(env["MIMIR_PUBLIC_ORIGINS"], /,/) ?? derivePublicOrigins(listen),
    allowedRoots: splitList(env["MIMIR_ALLOWED_ROOTS"], /[:,]/) ?? [],
    runtime: runtime as RuntimeChoice,
    tickMs: Math.floor(numberFrom(env, "MIMIR_TICK_MS", 0, 1000)),
    artifactRetentionDays: numberFrom(env, "MIMIR_ARTIFACT_RETENTION_DAYS", 1, 30),
    approvalTtlMs: numberFrom(env, "MIMIR_APPROVAL_TTL_MS", 1, null),
    maxArtifactBytes: Math.floor(numberFrom(env, "MIMIR_MAX_ARTIFACT_BYTES", 1, 64 * 1024 * 1024)),
    webRoot: nonEmpty(env["MIMIR_WEB_ROOT"]) ?? null,
  };
}

export interface AuthTokenInfo {
  token: string;
  source: "env" | "file" | "generated";
  /** File holding the token; `null` when it came from the environment. */
  path: string | null;
}

const uid = typeof process.getuid === "function" ? process.getuid() : null;

/** The data dir must be a real directory owned by this user; it is (re)set to 0700. */
function ensureDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = statSync(dir); // a symlinked data dir is fine if the target is ours
  if (!st.isDirectory()) throw new Error(`Mimir data dir ${dir} is not a directory`);
  if (uid !== null && st.uid !== uid) {
    throw new Error(`Mimir data dir ${dir} is owned by uid ${st.uid}, not ${uid}`);
  }
  chmodSync(dir, 0o700);
}

/** Reads the token file without following symlinks; tightens it to 0600. */
function readTokenFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      throw new Error(`Mimir token file ${path} must be a regular file`, { cause: err });
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`Mimir token file ${path} must be a regular file`);
    if (uid !== null && st.uid !== uid) {
      throw new Error(`Mimir token file ${path} is owned by uid ${st.uid}, not ${uid}`);
    }
    chmodSync(path, 0o600);
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Returns the API token: from the env, else `<data>/auth-token` (created 0600 on first start).
 * The data dir is forced to 0700. A token file that is a symlink, foreign-owned, or shorter than
 * `MIN_AUTH_TOKEN_LENGTH` is refused rather than silently trusted or replaced.
 */
export function ensureAuthToken(config: ServerConfig): AuthTokenInfo {
  ensureDataDir(config.dataDir);
  if (config.authTokenEnv !== null) {
    return { token: config.authTokenEnv, source: "env", path: null };
  }
  const path = config.authTokenPath;
  const existing = readTokenFile(path);
  if (existing !== null && existing.length > 0) {
    if (existing.length < MIN_AUTH_TOKEN_LENGTH) {
      throw new Error(
        `Mimir token file ${path} must hold at least ${MIN_AUTH_TOKEN_LENGTH} characters; delete it to generate a new token`,
      );
    }
    return { token: existing, source: "file", path };
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, source: "generated", path };
}
