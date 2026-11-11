import { createHash } from "node:crypto";
import { askGuide, EMPTY_DOCS, GUIDE_APPS, ProviderError, type DocsSource } from "@sindri/director";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, parseBody, toApiError } from "../errors.js";
import type { Factory } from "../factory.js";
import { guideState } from "../guide-state.js";
import type { Services } from "../services.js";
import { NO_IDEMPOTENCY } from "./approvals.js";

export interface GuideServerOptions {
  /** Docs the Guide answers from (`@factory/docs`). Default: none, and answers say so. */
  docs?: DocsSource;
  /** Requests per bucket (bearer token + `x-guide-client`) per window. Default 30 per 60 s. */
  rateLimit?: { max: number; windowMs: number };
  now?: () => Date;
}

const Ask = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  context: z
    .strictObject({
      app: z.enum(GUIDE_APPS),
      screen: z.string().trim().min(1).max(100).optional(),
      projectId: z.string().min(1).max(200).optional(),
    })
    .optional(),
});

/** Optional per-operator bucket id; a proxy sharing one token (Heimdall) sends a session hash. */
export const GUIDE_CLIENT_HEADER = "x-guide-client";
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/**
 * `POST /v1/guide/ask`: the read-only Guide. It reads docs and a state snapshot and asks the
 * configured provider once; it calls no mutating service, so it needs no Idempotency-Key.
 */
export function guideRoutes(
  app: FastifyInstance,
  s: Services,
  f: Pick<Factory, "provider">,
  o: GuideServerOptions = {},
) {
  const docs = o.docs ?? EMPTY_DOCS;
  const { max, windowMs } = o.rateLimit ?? { max: 30, windowMs: 60_000 };
  const now = o.now ?? (() => new Date());
  // Per bucket (hashed token + client id): timestamps of the requests inside the current window.
  const hits = new Map<string, number[]>();

  app.post("/v1/guide/ask", { config: { [NO_IDEMPOTENCY]: true } }, async (req, reply) => {
    // Validate before counting, so a rejected request costs no quota.
    const body = parseBody(Ask, req.body);
    const raw = req.headers[GUIDE_CLIENT_HEADER];
    let client: string | undefined;
    if (raw !== undefined) {
      // A repeated header arrives as an array or comma-joined; both fail the pattern.
      const r = ClientId.safeParse(raw);
      if (!r.success)
        throw new ApiError(
          422,
          "validation_failed",
          `${GUIDE_CLIENT_HEADER} must be 1-128 characters of A-Z a-z 0-9 _ -`,
        );
      client = r.data;
    }
    // NUL separates the parts, so no token/client split collides; absent header = token-only key.
    const key = createHash("sha256")
      .update(req.headers.authorization ?? "")
      .update(client === undefined ? "" : `\0${client}`)
      .digest("hex");
    const t = now().getTime();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      const retry = Math.max(1, Math.ceil((recent[0]! + windowMs - t) / 1000));
      return reply
        .code(429)
        .header("retry-after", String(retry))
        .send({
          error: {
            code: "rate_limited",
            message: `too many Guide questions; retry in ${retry} s`,
          },
        });
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (t - v.at(-1)! >= windowMs) hits.delete(k);

    const context = body.context ?? { app: "sindri" as const };
    const state = guideState(s.db, context.projectId);
    let answer;
    try {
      answer = await askGuide(f.provider(), {
        question: body.question,
        context,
        state,
        docs,
      });
    } catch (e) {
      // askGuide rethrows every provider failure as a ProviderError (503 either way).
      const api =
        e instanceof ProviderError
          ? toApiError(e)
          : new ApiError(503, "provider_unavailable", "LLM provider unavailable");
      throw new ApiError(
        api.status,
        api.code,
        `The Guide could not get an answer: ${api.message}. Check the provider in Settings and retry.`,
        api.details,
      );
    }
    if (answer.findings.length > 0)
      req.log.warn({ findings: answer.findings.length }, "guide: untrusted instructions redacted");
    reply.header("cache-control", "no-store");
    return { answer: answer.answer, links: answer.links, sources: answer.sources };
  });
}
