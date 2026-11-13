import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { DestinationStream } from "pino";
import { DEFAULT_WEB_ORIGINS } from "./config.js";
import { deliveryPurgeTargets } from "./delivery-purge.js";
import { DISPLAY_SANITIZED, forDisplay } from "./display.js";
import { ApiError, envelope, toApiError } from "./errors.js";
import { createFactory, type FactoryOptions } from "./factory.js";
import { changeRoutes } from "./routes/changes.js";
import { deliveryRoutes } from "./routes/deliveries.js";
import { executionRoutes } from "./routes/executions.js";
import { feedbackGraphRoutes } from "./routes/feedback-graph.js";
import type { DocsSource } from "@sindri/director";
import { GUIDE_CLIENT_HEADER, guideRoutes } from "./routes/guide.js";
import { guidanceRoutes } from "./routes/guidance.js";
import { harnessRoutes } from "./routes/harnesses.js";
import { intakeRoutes } from "./routes/intakes.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { planRoutes } from "./routes/plans.js";
import { prReviewRoutes } from "./routes/pr-reviews.js";
import { REDACTED_RECEIPT_BODY, receiptKey } from "./idempotency.js";
import { approvalRoutes, NO_IDEMPOTENCY, REDACTED_RECEIPT } from "./routes/approvals.js";
import { projectRoutes } from "./routes/projects.js";
import { settingsRoutes } from "./routes/settings.js";
import { specRoutes } from "./routes/specs.js";
import { stewardRoutes, type StewardServerOptions } from "./routes/steward.js";
import { APPROVAL_HEADER, ApprovalAuthority, type ApprovalOptions } from "./approval.js";
import { isLoopbackHostHeader, tokenMatches } from "./security.js";
import { createServices, type ServiceOptions, type Services } from "./services.js";

export const SERVER_VERSION = "0.0.0";

export interface BuildServerOptions extends ServiceOptions, FactoryOptions {
  /** Bearer token required on every /v1/* route except health. */
  authToken: string;
  /** Path of the SQLite file (used by export). */
  dbPath?: string;
  /** Data directory (export, token location hint). */
  dataDir?: string;
  /** Browser origins allowed to call the API. Default: the web dev origin. */
  allowedOrigins?: string[];
  /** Skip the loopback Host check (only with SINDRI_ALLOW_REMOTE=1 + TLS). */
  allowRemote?: boolean;
  /** Pino destination for logs; logging is off when neither this nor `logLevel` is set. */
  logStream?: DestinationStream;
  logLevel?: string;
  version?: string;
  /** TLS material; required by config for non-loopback binds. */
  https?: { cert: Buffer; key: Buffer };
  /** Resume interrupted executions when ready (default true; `sindri demo` turns it off). */
  resumeOnReady?: boolean;
  /** Approval pairing code handling (audit M9); the code reaches only `onPairingCode`. */
  approval?: ApprovalOptions;
  /** The steward loop (docs/steward.md). */
  steward?: StewardServerOptions;
  /** Docs the read-only Guide answers from. Default: none, and it says so; `startServer` passes `@factory/docs`. */
  docs?: DocsSource;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_HEADERS = `authorization, content-type, idempotency-key, ${APPROVAL_HEADER}, ${GUIDE_CLIENT_HEADER}`;
const REDACT = [
  "req.headers.authorization",
  `req.headers["${APPROVAL_HEADER}"]`,
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
];

/**
 * The path a request is handled as. The router matches the percent-decoded path (`/%761/x` is
 * `/v1/x`), so a matched request is judged by its route pattern; an unmatched one by its URL.
 */
const routePath = (req: FastifyRequest): string => req.routeOptions.url ?? req.url;
const isApi = (req: FastifyRequest) =>
  routePath(req).startsWith("/v1/") || req.url.startsWith("/v1/");

/** The project a mutation belongs to: from the URL, the body, or the response. */
function projectIdOf(req: FastifyRequest, responseBody: string): string | null {
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (routePath(req).startsWith("/v1/projects/") && typeof params["id"] === "string")
    return params["id"];
  const body = req.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === "object" && typeof body["projectId"] === "string")
    return body["projectId"];
  try {
    const res = JSON.parse(responseBody) as Record<string, unknown>;
    const project = res["project"] as Record<string, unknown> | undefined;
    if (project && typeof project["id"] === "string") return project["id"];
    for (const v of Object.values(res))
      if (
        v &&
        typeof v === "object" &&
        typeof (v as Record<string, unknown>)["projectId"] === "string"
      )
        return (v as Record<string, string>)["projectId"] ?? null;
  } catch {
    /* not JSON */
  }
  return null;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  const logging = opts.logStream !== undefined || opts.logLevel !== undefined;
  const app = Fastify({
    ...(opts.https ? { https: opts.https } : {}),
    logger: logging
      ? {
          level: opts.logLevel ?? "info",
          ...(opts.logStream ? { stream: opts.logStream } : {}),
          redact: { paths: REDACT, censor: "[Redacted]" },
          serializers: {
            req: (req: FastifyRequest) => ({
              method: req.method,
              url: req.url,
              headers: req.headers,
            }),
          },
        }
      : false,
    bodyLimit: 2 * 1024 * 1024,
  }) as unknown as FastifyInstance;
  const services: Services = createServices(opts);
  const origins = new Set(opts.allowedOrigins ?? DEFAULT_WEB_ORIGINS);
  const idemKeys = new WeakMap<FastifyRequest, string>();
  const redactedReceipts = new WeakSet<FastifyRequest>();

  app.setErrorHandler((err, req, reply) => {
    const e = toApiError(err);
    if (e.status >= 500) req.log.error({ err }, "request failed");
    return reply.code(e.status).send(envelope(e));
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send(envelope(new ApiError(404, "not_found", "route not found"))),
  );

  app.addHook("onRequest", async (req, reply) => {
    if (!isApi(req)) return;
    if (!opts.allowRemote && !isLoopbackHostHeader(req.headers.host))
      throw new ApiError(403, "host_forbidden", "Host header must be a loopback address");
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!origins.has(origin))
        throw new ApiError(403, "origin_forbidden", "Origin is not allowed");
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-expose-headers", "idempotency-replayed");
    }
    if (req.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE");
      reply.header("access-control-allow-headers", ALLOWED_HEADERS);
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
    if (routePath(req) === "/v1/health") return;
    if (!tokenMatches(req.headers.authorization, opts.authToken))
      throw new ApiError(401, "unauthorized", "a valid bearer token is required");
  });

  app.addHook("preHandler", async (req, reply) => {
    if (!MUTATING.has(req.method) || !isApi(req)) return;
    const config = req.routeOptions.config as unknown as Record<string, unknown> | undefined;
    if (config?.[NO_IDEMPOTENCY] === true) return;
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || key.length > 200)
      throw new ApiError(422, "idempotency_key_required", "an Idempotency-Key header is required");
    // A redacted receipt keeps only the key hash, a request hash and the status (review I3).
    const redacted = config?.[REDACTED_RECEIPT] === true;
    const storeKey = redacted ? receiptKey(key) : key;
    const stored = services.commands.begin(storeKey, req.method, redacted ? "" : req.url, req.body);
    if (stored) {
      reply.header("idempotency-replayed", "true");
      if (stored.contentType) reply.type(stored.contentType);
      return reply.code(stored.statusCode).send(stored.body);
    }
    idemKeys.set(req, storeKey);
    if (redacted) redactedReceipts.add(req);
  });

  // Every JSON response except settings is display-sanitized server-side.
  // Routes whose text was sanitized when stored opt out (successful responses only).
  app.addHook("preSerialization", async (req, reply, payload) =>
    routePath(req).startsWith("/v1/settings") ||
    (reply.statusCode < 400 &&
      (req.routeOptions.config as unknown as Record<string, unknown> | undefined)?.[
        DISPLAY_SANITIZED
      ] === true)
      ? payload
      : forDisplay(payload),
  );

  app.addHook("onSend", async (req, reply, payload) => {
    const key = idemKeys.get(req);
    if (!key) return payload;
    idemKeys.delete(req);
    const body =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf8")
          : null;
    if (reply.statusCode >= 500 || body === null) services.commands.release(key);
    else {
      const ct = reply.getHeader("content-type");
      if (redactedReceipts.has(req))
        services.commands.complete(key, {
          statusCode: reply.statusCode,
          contentType: "application/json; charset=utf-8",
          body: REDACTED_RECEIPT_BODY,
        });
      else
        services.commands.complete(
          key,
          { statusCode: reply.statusCode, contentType: typeof ct === "string" ? ct : null, body },
          projectIdOf(req, body),
        );
    }
    return payload;
  });
  // A request that errors before onSend (e.g. aborted) must not leave its key reserved.
  app.addHook("onResponse", async (req) => {
    const key = idemKeys.get(req);
    if (key) services.commands.release(key);
  });

  app.options("/v1/*", (_req, reply) => reply.code(204).send());
  app.get("/v1/health", () => ({ status: "ok" }));
  app.get("/v1/capabilities", () => ({
    serverVersion: opts.version ?? SERVER_VERSION,
    // Configured, not probed: GET /v1/mimir/status tests the connection.
    features: (() => {
      const st = services.settings.get();
      return {
        mimir: Boolean(st.mimirUrl && st.mimirTokenSecret),
        brokkr: st.brokkrEnabled === true,
      };
    })(),
  }));
  const approvals = new ApprovalAuthority({
    ...opts.approval,
    ...(opts.now ? { now: opts.now } : {}),
  });
  approvalRoutes(app, approvals);
  projectRoutes(app, services, approvals);
  intakeRoutes(app, services);
  specRoutes(app, services, approvals);
  knowledgeRoutes(app, services);
  guidanceRoutes(app, services);
  feedbackGraphRoutes(app, services);
  const factory = createFactory(
    {
      onRunError: (executionId, err) => app.log.error({ err, executionId }, "delivery run failed"),
      onWarn: (msg, fields) => app.log.warn(fields ?? {}, msg),
      ...opts,
    },
    services,
  );
  // Before the execution routes, so its preClose stops the loop before the hub closes.
  stewardRoutes(app, services, factory, approvals, {
    ...opts.steward,
    authToken: opts.authToken,
    now: opts.now ?? (() => new Date()),
    ...(opts.resumeOnReady !== undefined ? { resumeOnReady: opts.resumeOnReady } : {}),
    fixedProvider: opts.providerFactory !== undefined || opts.director !== undefined,
  });
  planRoutes(app, services, factory, approvals);
  harnessRoutes(app, services, factory);
  guideRoutes(app, services, factory, {
    ...(opts.docs ? { docs: opts.docs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  executionRoutes(app, services, factory, factory.hub, factory.delivery, approvals);
  changeRoutes(app, services.db);
  // Resume runs interrupted by a restart, without waiting for a client (review I2).
  app.addHook("onReady", async () => {
    if (opts.resumeOnReady !== false) void factory.resume();
  });
  app.addHook("preClose", async () => factory.close());
  deliveryRoutes(app, services, factory.hub, factory.delivery, approvals, factory);
  prReviewRoutes(app, services, factory.hub, factory.delivery, approvals, factory);
  settingsRoutes(app, services, {
    approvals,
    beforePurge: async (projectId) => {
      const t = deliveryPurgeTargets(services.db, projectId);
      await factory.hub.stop(t.executionIds);
      await factory.hub.cancelMissions(t.missionIds, "project data deleted in Sindri");
    },
    afterChange: () => factory.settingsChanged(),
    removeReviewMirror: (projectId) => factory.reviewMirror.remove(projectId),
    version: opts.version ?? SERVER_VERSION,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
  return app;
}
