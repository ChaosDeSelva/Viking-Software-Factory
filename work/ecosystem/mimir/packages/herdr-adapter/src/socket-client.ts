// NDJSON client for the HerdR socket API (0.9.4, protocol 22).
// Ported from spikes/herdr-spike/client.ts (same author, local work) and
// extended with MimirError mapping and socket path resolution.
//
// Wire facts this relies on (see docs/herdr/wire-facts.md):
// - One request per connection: the server reads one line, writes one
//   response, and closes. Every `request` opens a fresh connection.
// - A subscription is a connection kept open: an ack response
//   `{type:"subscription_started"}`, then pushed `{event, data}` lines.
// - Loss shows up as EOF (or, rarely, an `events_lost` error line), never as a
//   gap in a sequence number; `closed` reports which one happened.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MimirError, isMimirError, type ErrorCode } from "@mimir/protocol";

export class HerdrError extends Error {
  readonly code: string;
  readonly method: string | undefined;
  constructor(code: string, message: string, method?: string) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
    this.code = code;
    this.method = method;
  }
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface HerdrEnvelope {
  event: string;
  data: Record<string, unknown>;
}

export interface CloseInfo {
  reason: "eof" | "error" | "closed_by_client";
  error?: HerdrError;
}

export type SubscriptionSpec = string | { type: string; [k: string]: unknown };

export interface HerdrSubscription {
  close(): void;
  closed: Promise<CloseInfo>;
}

export interface SubscribeOptions {
  ackTimeoutMs?: number;
}

export interface HerdrSocketClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Longest NDJSON line accepted before the connection is failed (`line_too_long`). */
  maxLineBytes?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Cap on one NDJSON line (audit M4: a newline-free stream must not grow memory unboundedly). */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

let nextId = 0;
const newRequestId = (prefix: string) => `${prefix}_${process.pid}_${++nextId}`;

type Line = { id?: unknown; result?: unknown; error?: unknown; event?: unknown; data?: unknown };

/**
 * Splits a byte stream into parsed JSON lines; malformed lines are dropped. A pending line
 * longer than `maxLineBytes` calls `onOverflow` once and stops reading.
 */
function lineReader(
  onLine: (msg: Line) => void,
  maxLineBytes: number,
  onOverflow: (err: HerdrError) => void,
) {
  let buf = "";
  let failed = false;
  return (chunk: Buffer) => {
    if (failed) return;
    buf += chunk.toString("utf8");
    const tail = buf.length - (buf.lastIndexOf("\n") + 1);
    if (tail > maxLineBytes) {
      failed = true;
      buf = "";
      onOverflow(new HerdrError("line_too_long", `NDJSON line exceeds ${maxLineBytes} bytes`));
      return;
    }
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object") onLine(msg as Line);
    }
  };
}

const getuid = typeof process.getuid === "function" ? process.getuid.bind(process) : null;

/**
 * Audit M4: before connecting, the path must be a socket (not a symlink or planted file) owned by
 * this user, and neither it nor its directory may be writable by group or others. Otherwise a
 * local process could stand in for HerdR (e.g. via a `HERDR_SOCKET_PATH` in /tmp).
 */
export async function assertTrustedSocket(socketPath: string): Promise<void> {
  const untrusted = (why: string) => new HerdrError("socket_untrusted", `${socketPath}: ${why}`);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(socketPath);
  } catch (e) {
    throw new HerdrError("connect_failed", `${socketPath}: ${(e as Error).message}`);
  }
  if (!st.isSocket()) throw untrusted("not a socket");
  const uid = getuid?.();
  if (uid !== undefined && st.uid !== uid) throw untrusted(`owned by uid ${st.uid}, not ${uid}`);
  if ((st.mode & 0o022) !== 0) throw untrusted("socket is group/other writable");
  const dir = await fs.stat(path.dirname(socketPath));
  if (uid !== undefined && dir.uid !== uid) throw untrusted(`directory owned by uid ${dir.uid}`);
  if ((dir.mode & 0o022) !== 0) throw untrusted("directory is group/other writable");
}

async function openSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  await assertTrustedSocket(socketPath);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new HerdrError("connect_failed", `timed out connecting to ${socketPath}`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(new HerdrError("connect_failed", `${socketPath}: ${e.message}`));
    });
  });
}

function toHerdrError(body: unknown, method?: string): HerdrError {
  const b = (body ?? {}) as { code?: unknown; message?: unknown };
  return new HerdrError(
    String(b.code ?? "unknown_error"),
    String(b.message ?? JSON.stringify(body)),
    method,
  );
}

export class HerdrSocketClient {
  readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(socketPath: string, opts: HerdrSocketClientOptions = {}) {
    this.socketPath = socketPath;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Sends one request on a fresh connection. Rejects with `HerdrError`. */
  async request<T = unknown>(
    method: string,
    params: unknown = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    const sock = await openSocket(this.socketPath, this.connectTimeoutMs);
    const id = newRequestId("req");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new HerdrError("timeout", `no response to ${method} within ${timeoutMs}ms`, method),
            ),
          ),
        timeoutMs,
      );
      sock.on(
        "data",
        lineReader(
          (msg) => {
            if (msg.id !== id) return;
            if (msg.error) finish(() => reject(toHerdrError(msg.error, method)));
            else finish(() => resolve(msg.result as T));
          },
          this.maxLineBytes,
          (err) => finish(() => reject(err)),
        ),
      );
      sock.on("error", () => {});
      sock.on("close", () =>
        finish(() =>
          reject(new HerdrError("connection_closed", "socket closed before response", method)),
        ),
      );
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /**
   * Opens a dedicated connection, sends `events.subscribe`, and resolves once
   * the server acks. A later error line carrying the subscribe id (for example
   * `events_lost`) is reported through `closed`.
   */
  async subscribe(
    specs: SubscriptionSpec[],
    onEvent: (e: HerdrEnvelope) => void,
    opts: SubscribeOptions = {},
  ): Promise<HerdrSubscription> {
    const sock = await openSocket(this.socketPath, this.connectTimeoutMs);
    const id = newRequestId("sub");
    const subscriptions = specs.map((s) => (typeof s === "string" ? { type: s } : s));
    let acked = false;
    let closing = false;
    let lateError: HerdrError | undefined;
    let resolveClosed!: (c: CloseInfo) => void;
    const closed = new Promise<CloseInfo>((r) => (resolveClosed = r));
    const ackTimeoutMs = opts.ackTimeoutMs ?? this.requestTimeoutMs;

    return new Promise<HerdrSubscription>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(
          new HerdrError(
            "timeout",
            `no subscription ack within ${ackTimeoutMs}ms`,
            "events.subscribe",
          ),
        );
      }, ackTimeoutMs);

      sock.on(
        "data",
        lineReader(
          (msg) => {
            if (msg.id === id) {
              if (msg.error) {
                const err = toHerdrError(msg.error, "events.subscribe");
                if (!acked) {
                  clearTimeout(timer);
                  sock.destroy();
                  reject(err);
                } else {
                  lateError = err;
                }
                return;
              }
              if (!acked) {
                acked = true;
                clearTimeout(timer);
                resolve({
                  closed,
                  close() {
                    closing = true;
                    sock.destroy();
                  },
                });
              }
              return;
            }
            if (acked && typeof msg.event === "string") {
              onEvent({ event: msg.event, data: (msg.data ?? {}) as Record<string, unknown> });
            }
          },
          this.maxLineBytes,
          (err) => {
            if (!acked) {
              clearTimeout(timer);
              reject(err);
            } else {
              lateError = err;
            }
            sock.destroy();
          },
        ),
      );
      sock.on("error", () => {});
      sock.on("close", () => {
        if (!acked) {
          clearTimeout(timer);
          reject(
            new HerdrError(
              "connection_closed",
              "socket closed before subscription ack",
              "events.subscribe",
            ),
          );
        }
        if (lateError) resolveClosed({ reason: "error", error: lateError });
        else resolveClosed({ reason: closing ? "closed_by_client" : "eof" });
      });
      sock.write(
        JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n",
      );
    });
  }
}

const CODE_MAP: Record<string, ErrorCode> = {
  not_found: "not_found",
  pane_not_found: "not_found",
  agent_not_found: "not_found",
  agent_pane_not_found: "not_found",
  invalid_request: "validation_failed",
  invalid_params: "validation_failed",
  invalid_agent_name: "validation_failed",
  invalid_agent_argument: "validation_failed",
  invalid_agent_timeout: "validation_failed",
  invalid_regex: "validation_failed",
  agent_pane_busy: "conflict",
  agent_not_ready: "conflict",
  timeout: "runtime_unavailable",
  connect_failed: "runtime_unavailable",
  socket_untrusted: "runtime_unavailable",
  line_too_long: "runtime_unavailable",
  connection_closed: "runtime_unavailable",
  server_unavailable: "runtime_unavailable",
  unknown_method: "capability_unavailable",
  protocol_mismatch: "capability_unavailable",
  unsupported_agent_kind: "capability_unavailable",
};
const RETRYABLE = new Set([
  "agent_pane_busy",
  "agent_not_ready",
  "timeout",
  "connect_failed",
  "connection_closed",
]);

/** Maps a HerdR error (or anything thrown) to a `MimirError`. */
export function toMimirError(err: unknown): MimirError {
  if (isMimirError(err)) return err;
  if (err instanceof HerdrError) {
    const code = CODE_MAP[err.code] ?? "internal";
    const details: { herdrCode: string; method?: string; retryable: boolean } = {
      herdrCode: err.code,
      retryable: RETRYABLE.has(err.code),
    };
    if (err.method !== undefined) details.method = err.method;
    return new MimirError(code, err.message, details, { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new MimirError("internal", message, undefined, { cause: err });
}

export interface SocketPathOptions {
  socketPath?: string | undefined;
  sessionName?: string | undefined;
  env?: Record<string, string | undefined>;
  home?: string;
}

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sessionSocket(home: string, name: string): string {
  if (name === "default") return path.join(home, ".config/herdr/herdr.sock");
  if (!SESSION_NAME.test(name) || name.includes("..")) {
    throw new MimirError("validation_failed", `invalid HerdR session name: ${name}`);
  }
  return path.join(home, ".config/herdr/sessions", name, "herdr.sock");
}

/**
 * Socket path resolution: explicit `socketPath` → explicit `sessionName` →
 * `HERDR_SOCKET_PATH` → `HERDR_SESSION` → `~/.config/herdr/herdr.sock`.
 * The adapter supplies `sessionName: "mimir"` by default so it never lands on
 * the user's default session unless configured to.
 */
export function resolveSocketPath(opts: SocketPathOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  if (opts.socketPath) return opts.socketPath;
  if (opts.sessionName) return sessionSocket(home, opts.sessionName);
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SESSION) return sessionSocket(home, env.HERDR_SESSION);
  return path.join(home, ".config/herdr/herdr.sock");
}
