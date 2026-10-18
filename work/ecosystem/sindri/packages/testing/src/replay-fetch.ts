export interface RecordedRequest {
  method: string;
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body?: string;
}

export interface ReplayRoute {
  /** Default "GET". */
  method?: string;
  url: string | RegExp;
  /** Extra predicate on the recorded request. */
  match?: (req: RecordedRequest) => boolean;
  /** Default 200. */
  status?: number;
  /** Serialised as JSON unless already a string. */
  body: unknown;
  headers?: Record<string, string>;
}

export interface ReplayFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * A fake `fetch` that only answers from recorded routes. Any request that does not
 * match a route rejects, so tests can never touch the network.
 */
export function createReplayFetch(routes: readonly ReplayRoute[]): ReplayFetch {
  const requests: RecordedRequest[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: RecordedRequest = { method, url, headers };
    if (typeof init?.body === "string") req.body = init.body;
    requests.push(req);
    const route = routes.find(
      (r) =>
        (r.method ?? "GET").toUpperCase() === method &&
        (typeof r.url === "string" ? r.url === url : r.url.test(url)) &&
        (r.match ? r.match(req) : true),
    );
    if (!route) throw new Error(`unexpected request: ${method} ${url}`);
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...route.headers },
    });
  };
  return { fetch: fake as typeof fetch, requests };
}
