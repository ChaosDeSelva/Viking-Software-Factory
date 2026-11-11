import { FeedbackGraphClient } from "./client.js";
import { normalizeLessons } from "./normalize.js";
import type {
  FgConfig,
  FgError,
  FgLesson,
  FgLink,
  FgProjectView,
  FgResult,
  FgStatus,
  SecretReader,
} from "./types.js";

/** Default cache lifetime of a project's link and lessons. */
export const CACHE_TTL_MS = 60_000;
/** Failures are cached for less, so a Feedback Graph that comes back is noticed soon. */
export const FAILURE_TTL_MS = 10_000;
/** `GET /status` probes at most this often. */
export const STATUS_TTL_MS = 5_000;
export const DEFAULT_LESSON_LIMIT = 20;

/** Key of the operator's project-key override inside a Sindri project's `settings`. */
export const PROJECT_OVERRIDE_KEY = "feedbackGraphProject";

/** Feedback Graph project keys: what its own API accepts as a project (`^\w[\w.-]*$`). */
export const PROJECT_KEY = /^\w[\w.-]{0,199}$/;

export interface FgProjectRef {
  id: string;
  repoPath: string;
  /** The operator's override; undefined/null when none is stored. */
  override?: string | null;
}

export interface FeedbackGraphServiceOptions {
  /** Current setting, read on every call (settings can change at any time). */
  config: () => FgConfig | undefined;
  /** Why the configured URL may not be used (local-only mode), or null. */
  blocked?: (config: FgConfig) => string | null;
  secrets?: SecretReader;
  /** The Sindri project, or undefined when unknown. */
  project: (projectId: string) => FgProjectRef | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
  failureTtlMs?: number;
  /** Clock in ms (tests). */
  now?: () => number;
}

interface Entry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

type Usable = { ok: true; client: FeedbackGraphClient } | { ok: false; error: FgError };

const err = (code: FgError["code"], message: string): FgError => ({ code, message });

export interface FeedbackGraphService {
  status(): Promise<FgStatus>;
  /** Never throws; [] when not configured, disabled, unmapped, unreachable or unknown. */
  lessonsFor(projectId: string, opts?: { limit?: number }): Promise<FgLesson[]>;
  /** The project's link, its lessons and why there are none. Undefined for an unknown project. */
  projectView(projectId: string, opts?: { limit?: number }): Promise<FgProjectView | undefined>;
  /** Drop cached links and lessons (one project, or all). */
  invalidate(projectId?: string): void;
}

export function createFeedbackGraphService(o: FeedbackGraphServiceOptions): FeedbackGraphService {
  const now = o.now ?? (() => Date.now());
  const ttl = o.cacheTtlMs ?? CACHE_TTL_MS;
  const failureTtl = o.failureTtlMs ?? FAILURE_TTL_MS;
  const cache = new Map<string, Entry<unknown>>();
  let statusCache: Entry<FgStatus> & { key: string } | undefined;

  const configKey = (c: FgConfig) => JSON.stringify([c.url, c.tokenSecret, c.enabled]);

  /** A cached promise per key; a result that is a failure lives `failureTtl`. */
  function cached<T>(key: string, load: () => Promise<T>, failed: (v: T) => boolean): Promise<T> {
    const hit = cache.get(key) as Entry<T> | undefined;
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const entry: Entry<T> = { at: now(), ttl, value: load() };
    cache.set(key, entry as Entry<unknown>);
    void entry.value.then(
      (v) => {
        if (failed(v)) entry.ttl = failureTtl;
      },
      () => cache.delete(key),
    );
    return entry.value;
  }

  /** The configuration, checked, with its token; a client ready to call. */
  async function usable(): Promise<Usable> {
    const c = o.config();
    if (!c) return { ok: false, error: err("not_configured", "Feedback Graph is not configured") };
    if (!c.enabled) return { ok: false, error: err("disabled", "Feedback Graph is disabled") };
    const blocked = o.blocked?.(c) ?? null;
    if (blocked) return { ok: false, error: err("blocked", blocked) };
    let token: string | undefined;
    try {
      token = await o.secrets?.get(c.tokenSecret);
    } catch {
      token = undefined;
    }
    if (!token)
      return {
        ok: false,
        error: err(
          "token_missing",
          `no Feedback Graph token is stored under the secret name "${c.tokenSecret}"`,
        ),
      };
    return {
      ok: true,
      client: new FeedbackGraphClient({
        url: c.url,
        token,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
      }),
    };
  }

  const overrideOf = (p: FgProjectRef) =>
    typeof p.override === "string" && PROJECT_KEY.test(p.override) ? p.override : null;

  async function link(p: FgProjectRef): Promise<{ link: FgLink; error: FgError | null }> {
    const override = overrideOf(p);
    if (override) return { link: { projectKey: override, source: "override" }, error: null };
    const c = o.config();
    const key = `link|${c ? configKey(c) : "-"}|${p.id}|${p.repoPath}`;
    return cached(
      key,
      async (): Promise<{ link: FgLink; error: FgError | null }> => {
        const u = await usable();
        if (!u.ok) return { link: { projectKey: null, source: "none" }, error: u.error };
        const r = await u.client.projectFor(p.repoPath);
        if (!r.ok) return { link: { projectKey: null, source: "none" }, error: r.error };
        return r.value
          ? { link: { projectKey: r.value, source: "auto" }, error: null }
          : {
              link: { projectKey: null, source: "none" },
              error: null,
            };
      },
      (v) => v.error !== null,
    );
  }

  function lessonsOf(projectKey: string): Promise<FgResult<FgLesson[]>> {
    const c = o.config();
    return cached(
      `lessons|${c ? configKey(c) : "-"}|${projectKey}`,
      async (): Promise<FgResult<FgLesson[]>> => {
        const u = await usable();
        if (!u.ok) return u;
        const r = await u.client.lessons(projectKey);
        if (!r.ok) return r;
        const lessons = normalizeLessons(r.value);
        return lessons
          ? { ok: true, value: lessons }
          : {
              ok: false,
              error: err("invalid_response", "Feedback Graph answered lessons that are not a list"),
            };
      },
      (v) => !v.ok,
    );
  }

  const clampLimit = (n: number | undefined) =>
    Math.max(0, Math.min(200, Math.floor(n ?? DEFAULT_LESSON_LIMIT)));

  async function view(projectId: string, limit?: number): Promise<FgProjectView | undefined> {
    const p = o.project(projectId);
    if (!p) return undefined;
    const l = await link(p);
    if (!l.link.projectKey) return { link: l.link, lessons: [], error: l.error?.message ?? null };
    const r = await lessonsOf(l.link.projectKey);
    return r.ok
      ? { link: l.link, lessons: r.value.slice(0, clampLimit(limit)), error: null }
      : { link: l.link, lessons: [], error: r.error.message };
  }

  return {
    async status() {
      const c = o.config();
      if (!c) return { configured: false, enabled: false, url: null, reachable: null, error: null };
      const base = { configured: true, enabled: c.enabled, url: c.url };
      if (!c.enabled) return { ...base, reachable: null, error: null };
      const key = configKey(c);
      if (statusCache?.key === key && now() - statusCache.at < statusCache.ttl)
        return statusCache.value;
      const value = (async (): Promise<FgStatus> => {
        try {
          const u = await usable();
          if (!u.ok) return { ...base, reachable: null, error: u.error.message };
          // Authenticated and cheap: says both "reachable" and "the token works".
          const r = await u.client.getJson("/api/agent/project", { cwd: "/" });
          if (r.ok) return { ...base, reachable: true, error: null };
          const down = r.error.code === "unreachable" || r.error.code === "timeout";
          return { ...base, reachable: !down, error: r.error.message };
        } catch {
          return { ...base, reachable: false, error: "Feedback Graph status check failed" };
        }
      })();
      statusCache = { key, at: now(), ttl: STATUS_TTL_MS, value };
      return value;
    },

    async lessonsFor(projectId, opts = {}) {
      try {
        return (await view(projectId, opts.limit))?.lessons ?? [];
      } catch {
        return [];
      }
    },

    async projectView(projectId, opts = {}) {
      try {
        return await view(projectId, opts.limit);
      } catch {
        return {
          link: { projectKey: null, source: "none" },
          lessons: [],
          error: "Feedback Graph lookup failed",
        };
      }
    },

    invalidate(projectId) {
      statusCache = undefined;
      if (!projectId) return cache.clear();
      for (const k of cache.keys()) if (k.startsWith("link|") && k.includes(`|${projectId}|`)) cache.delete(k);
    },
  };
}
