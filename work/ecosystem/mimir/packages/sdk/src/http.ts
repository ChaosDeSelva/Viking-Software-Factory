import {
  ApiErrorBodySchema,
  IDEMPOTENCY_HEADER,
  MimirError,
  toValidationIssues,
  type ValidationIssue,
} from "@mimir/protocol";

/**
 * The part of a protocol Zod schema the client uses. Declared structurally so the SDK needs no
 * direct `zod` dependency; every schema exported by `@mimir/protocol` satisfies it.
 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: Parameters<typeof toValidationIssues>[0] | HandValidationError };
}

/** Failure produced by the SDK's hand-written validators (used where the protocol has no schema). */
export interface HandValidationError {
  handWritten: true;
  issues: ValidationIssue[];
}

/** A bearer token, or a function returning one (called per request, so tokens can rotate). */
export type TokenSource = string | (() => string | Promise<string>);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  token?: TokenSource;
  fetch?: FetchLike;
  idempotencyKeyFactory?: () => string;
}

/** Per-call options for reads. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Per-call options for mutations. Without `idempotencyKey` a fresh key is generated. */
export interface MutationOptions extends RequestOptions {
  idempotencyKey?: string;
}

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

/** `crypto.randomUUID` where available (Node, secure browser contexts), else a v4 UUID from getRandomValues. */
export function randomKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A successful raw (non-JSON) response body and its headers. */
export interface RawResponse {
  bytes: Uint8Array;
  headers: Headers;
}

/** Shared HTTP plumbing: URL building, auth, idempotency keys, error and response parsing. */
export class Http {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  private readonly token: TokenSource | undefined;
  private readonly keyFactory: () => string;

  constructor(options: HttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.keyFactory = options.idempotencyKeyFactory ?? randomKey;
  }

  url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      params.append(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs === "" ? "" : `?${qs}`}`;
  }

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...extra };
    if (this.token !== undefined) {
      const t = typeof this.token === "function" ? await this.token() : this.token;
      h["authorization"] = `Bearer ${t}`;
    }
    return h;
  }

  async get<T>(
    schema: ResponseSchema<T>,
    path: string,
    query?: Query,
    options: RequestOptions = {},
  ): Promise<T> {
    const res = await this.fetch(this.url(path, query), {
      method: "GET",
      headers: await this.headers({ accept: "application/json" }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.parse(schema, res, path);
  }

  async post<T>(
    schema: ResponseSchema<T>,
    path: string,
    body: unknown,
    options: MutationOptions = {},
  ): Promise<T> {
    const key = options.idempotencyKey ?? this.keyFactory();
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: await this.headers({
        accept: "application/json",
        "content-type": "application/json",
        [IDEMPOTENCY_HEADER]: key,
      }),
      body: JSON.stringify(body ?? {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.parse(schema, res, path);
  }

  /**
   * GET returning the raw body (`fetch` + `arrayBuffer`) for non-JSON resources such as artifact
   * content. Non-2xx responses become `MimirError` exactly like JSON routes.
   */
  async getRaw(path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const res = await this.fetch(this.url(path), {
      method: "GET",
      headers: await this.headers({ accept: "*/*" }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) throw await errorFromResponse(res);
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }

  /** Raw JSON of a successful response, or a thrown `MimirError`. */
  async json(res: Response): Promise<unknown> {
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return (await res.json()) as unknown;
    } catch (cause) {
      throw new MimirError(
        "internal",
        "response is not valid JSON",
        { status: res.status },
        {
          cause,
        },
      );
    }
  }

  private async parse<T>(schema: ResponseSchema<T>, res: Response, path: string): Promise<T> {
    return parseResponse(schema, await this.json(res), path);
  }
}

export function parseResponse<T>(schema: ResponseSchema<T>, json: unknown, path: string): T {
  const r = schema.safeParse(json);
  if (!r.success) {
    throw new MimirError("validation_failed", `response from ${path} does not match the protocol`, {
      path,
      issues: "handWritten" in r.error ? r.error.issues : toValidationIssues(r.error),
    });
  }
  return r.data;
}

/** Converts a non-2xx response to `MimirError`, keeping the server's code when the body is an `ApiErrorBody`. */
export async function errorFromResponse(res: Response): Promise<MimirError> {
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const body = ApiErrorBodySchema.safeParse(json);
  if (body.success) {
    const { code, message, details } = body.data.error;
    return new MimirError(code, message, details);
  }
  return new MimirError("internal", `HTTP ${res.status} without a Mimir error body`, {
    status: res.status,
    body: text.slice(0, 500),
  });
}
