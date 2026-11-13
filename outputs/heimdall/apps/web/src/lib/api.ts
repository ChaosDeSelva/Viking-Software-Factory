// Same-origin calls to Heimdall's server. Every POST carries the request header the server
// requires and a fresh idempotency key unless the caller passes its own.
export type R = Record<string, any>;
export type Api = (path: string, options?: RequestInit) => Promise<R>;
/** Called with the source's answer, or its refusal; onError returning true closes the dialog. */
export interface CommandHooks {
  onSuccess?: (result: R) => void;
  onError?: (
    error: Error & { code?: string; details?: unknown },
  ) => boolean | void;
}
export type Propose = (
  action: string,
  id: string,
  body?: R,
  extra?: R,
  hooks?: CommandHooks,
) => void;

// Set by the app: a 401 may mean the session ended, so it re-checks and returns to sign-in.
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};
export const unauthorized = () => onUnauthorized?.();

export async function api(path: string, options: RequestInit = {}): Promise<R> {
  const r = await fetch("/api/" + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-heimdall-request": "1",
      "idempotency-key": crypto.randomUUID(),
      ...options.headers,
    },
  });
  if (r.status === 401 && path !== "login" && path !== "session")
    onUnauthorized?.();
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(Error(data.message ?? `HTTP ${r.status}`), {
      code: data.code,
      details: data.details,
    });
  return data;
}
export const post = (path: string, data: R) =>
  api(path, { method: "POST", body: JSON.stringify(data) });

/** Sindri's Guide through Heimdall's passthrough; shared by the Ask drawer and Overview's card. */
export const askGuide = (question: string, context: R) =>
  post("details/guide/ask", { question, context }).then((r) => ({
    answer: String(r.answer ?? ""),
    links: Array.isArray(r.links) ? r.links : [],
  }));

/** Saves a text as a file through a temporary object URL (patches, exported configuration). */
export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
