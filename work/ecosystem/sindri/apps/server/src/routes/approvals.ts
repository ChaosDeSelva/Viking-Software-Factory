import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import { parseBody } from "../errors.js";

/** Route config key: no Idempotency-Key and no stored response (the body holds a secret). */
export const NO_IDEMPOTENCY = "noIdempotency";

/**
 * Route config key: the idempotency record keeps only the key hash, a request hash and the
 * status, never the URL, response or project (project purge, review I3).
 */
export const REDACTED_RECEIPT = "redactedReceipt";

const MintBody = z.strictObject({
  pairingCode: z.string().trim().min(1).max(64),
  channel: z.enum(["web", "cli"]),
});

/**
 * `POST /v1/approval-session`: trade the pairing code shown on the server's terminal for an
 * approval secret (audit M9). The secret is in this response only; it is never stored, logged
 * or replayed by the idempotency ledger.
 */
export function approvalRoutes(app: FastifyInstance, approvals: ApprovalAuthority) {
  app.post("/v1/approval-session", { config: { [NO_IDEMPOTENCY]: true } }, (req, reply) => {
    const body = parseBody(MintBody, req.body);
    reply.header("cache-control", "no-store");
    return reply.code(201).send(approvals.mint(body.pairingCode, body.channel));
  });
}
