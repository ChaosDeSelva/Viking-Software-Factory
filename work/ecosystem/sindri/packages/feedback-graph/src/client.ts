import type { FgError, FgResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 3000;
/** Lesson objects are large (checks, provenance): a few hundred fit well inside this. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface FgClientOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Whole request, body included. */
  timeoutMs?: number;
  maxBytes?: number;
}

const fail = (code: FgError["code"], message: string): { ok: false; error: FgError } => ({
  ok: false,
  error: { code, message },
});

class TooLarge extends Error {}

/** Reads at most `max` bytes of a response body; more is an error, not a truncation. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read-only JSON client for a Feedback Graph API. Every call resolves to a result, never
 * throws; error messages never contain the token. Redirects are refused, so the bearer token
 * cannot be forwarded to another origin.
 */
export class FeedbackGraphClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(o: FgClientOptions) {
    this.#base = o.url.replace(/\/+$/, "");
    this.#token = o.token;
    this.#fetch = o.fetch ?? globalThis.fetch;
    this.#timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async getJson(path: string, query: Record<string, string> = {}): Promise<FgResult<unknown>> {
    let url: URL;
    try {
      url = new URL(this.#base + path);
    } catch {
      return fail("invalid_response", "the Feedback Graph URL is not valid");
    }
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json" },
        redirect: "error",
        signal,
      });
    } catch {
      return signal.aborted
        ? fail("timeout", `Feedback Graph did not answer within ${this.#timeoutMs} ms`)
        : fail("unreachable", "Feedback Graph is not reachable");
    }
    let text: string;
    try {
      text = await readCapped(res, this.#maxBytes);
    } catch (e) {
      if (e instanceof TooLarge)
        return fail("too_large", `Feedback Graph response is larger than ${this.#maxBytes} bytes`);
      return signal.aborted
        ? fail("timeout", `Feedback Graph did not answer within ${this.#timeoutMs} ms`)
        : fail("unreachable", "Feedback Graph closed the connection");
    }
    if (res.status === 401 || res.status === 403)
      return fail(
        "unauthorized",
        `Feedback Graph rejected the token (${res.status}): check the token stored under the configured secret name`,
      );
    if (!res.ok) return fail("http_error", `Feedback Graph answered ${res.status}`);
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return fail("invalid_response", "Feedback Graph answered with invalid JSON");
    }
  }

  /** `GET /api/agent/project?cwd=`: the Feedback Graph project tracking a host directory. */
  async projectFor(cwd: string): Promise<FgResult<string | null>> {
    const r = await this.getJson("/api/agent/project", { cwd });
    if (!r.ok) return r;
    const v = r.value as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return fail("invalid_response", "Feedback Graph answered with an unexpected project shape");
    const p = v["project"];
    if (p !== null && p !== undefined && typeof p !== "string")
      return fail("invalid_response", "Feedback Graph answered with an unexpected project shape");
    return { ok: true, value: typeof p === "string" && p && v["tracked"] !== false ? p : null };
  }

  /** `GET /api/lessons?project=&status=approved`: the raw body (normalised by the caller). */
  lessons(projectKey: string): Promise<FgResult<unknown>> {
    return this.getJson("/api/lessons", { project: projectKey, status: "approved" });
  }
}
