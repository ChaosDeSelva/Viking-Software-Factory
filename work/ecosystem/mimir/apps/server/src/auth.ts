import { createHash, timingSafeEqual } from "node:crypto";
import { MimirError } from "@mimir/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Route patterns reachable without a bearer token. Matched against the route Fastify actually
 * dispatched to (`request.routeOptions.url`), never against the raw request URL: the router
 * percent-decodes the path, so a raw-string check is bypassable (`/%761/projects`, audit C1).
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/v1/health"]);

declare module "fastify" {
  interface FastifyContextConfig {
    publicStatic?: boolean;
  }
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time token comparison (hashing first equalises lengths). */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export interface RegisteredRoute {
  method: string;
  url: string;
}
const ROUTES = new WeakMap<FastifyInstance, RegisteredRoute[]>();

/** Every route registered after `registerSecurity` (used by the encoded-path regression tests). */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  return [...(ROUTES.get(app) ?? [])];
}

/**
 * The route pattern this request was dispatched to (e.g. `/v1/projects/:id`), or `null` when no
 * route matched (the not-found handler). Security decisions use this, not `request.url`.
 */
export function routeOf(request: FastifyRequest): string | null {
  return request.routeOptions.url ?? null;
}

/** True only for a request the router dispatched to an explicitly public route. */
export function isPublicRoute(request: FastifyRequest): boolean {
  const route = routeOf(request);
  if (route !== null && PUBLIC_PATHS.has(route)) return true;
  if (route !== "/*" || request.routeOptions.config.publicStatic !== true) return false;
  try {
    const path = decodeURIComponent(request.url.split("?")[0] ?? "");
    return path !== "/v1" && !path.startsWith("/v1/");
  } catch {
    return false;
  }
}

export interface SecurityOptions {
  authToken: string;
  /** Third-party origins allowed to call the API (e.g. the web dev server). */
  allowedOrigins: readonly string[];
  /** Origins this server is reached at (from config). Never derived from request headers. */
  publicOrigins: readonly string[];
  /** Whether the server speaks TLS (scheme for bound-port loopback origins and Host checks). */
  tls: boolean;
}

/** Loopback host names accepted at the bound port when listening on a loopback address. */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** `URL.origin` normalisation (lowercase, default port dropped); null when unparseable/opaque. */
export function normalizeOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith("127.") || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Host validation (DNS-rebinding guard): the `Host` header must name one of this server's own
 * origins: the configured `publicOrigins`, plus loopback names at the bound port when the server
 * listens on loopback. CSRF: an `Origin` header must be one of those or on the allowlist.
 * Auth: deny by default. Every request, including unmatched paths (401 before 404), needs
 * `Authorization: Bearer` unless the router dispatched it to a `PUBLIC_PATHS` route.
 */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const scheme = options.tls ? "https" : "http";
  const configured = options.publicOrigins
    .map(normalizeOrigin)
    .filter((o): o is string => o !== null);
  const allowed = new Set(
    options.allowedOrigins.map(normalizeOrigin).filter((o): o is string => o !== null),
  );
  let bound: string[] | null = null;
  const ownOrigins = (): Set<string> => {
    if (bound === null && app.server.listening) {
      const addr = app.server.address();
      bound = [];
      if (addr !== null && typeof addr === "object" && isLoopbackAddress(addr.address)) {
        for (const name of LOOPBACK_NAMES) {
          const o = normalizeOrigin(`${scheme}://${name}:${addr.port}`);
          if (o !== null) bound.push(o);
        }
      }
    }
    return new Set([...configured, ...(bound ?? [])]);
  };

  const routes: RegisteredRoute[] = [];
  ROUTES.set(app, routes);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  });

  app.addHook("onRequest", async (request) => {
    const own = ownOrigins();
    const host = request.headers.host;
    const hostOrigin = host === undefined ? null : normalizeOrigin(`${scheme}://${host}`);
    if (hostOrigin === null || !own.has(hostOrigin)) {
      throw new MimirError("policy_denied", "host not allowed", { host: host ?? null });
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const o = normalizeOrigin(origin);
      if (o === null || (!own.has(o) && !allowed.has(o))) {
        throw new MimirError("policy_denied", "origin not allowed", { origin });
      }
    }
    if (isPublicRoute(request)) return;
    const header = request.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match || !tokenMatches(match[1] as string, options.authToken)) {
      throw new MimirError("unauthorized", "missing or invalid bearer token");
    }
  });
}
