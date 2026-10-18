import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";

/** Header carrying the approval secret on approval routes (audit M9). */
export const APPROVAL_HEADER = "x-sindri-approval";

export interface ApprovalOptions {
  /** Fixed pairing code (tests). Default: a random code shown only on the server's terminal. */
  pairingCode?: string;
  /** Receives the pairing code once at startup (`sindri start` prints it to its own stderr). */
  onPairingCode?: (code: string) => void;
  /** Session lifetime. Default 12 h. */
  ttlMs?: number;
  /** Wrong pairing codes before minting locks for a window (60 s, doubling each time). Default 5. */
  maxFailures?: number;
  now?: () => Date;
}

export type ApprovalChannel = "web" | "cli";

interface Session {
  id: string;
  principal: string;
  expiresAt: number;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 10 characters from a 32-symbol alphabet (50 bits), shown as XXXXX-XXXXX. */
function newPairingCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]!).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const normalize = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, "");

/**
 * The human-presence factor for approvals (audit M9). The bearer token is readable by any
 * process of the same OS user, Mimir-launched agents included, so it cannot tell a human from
 * an agent. Approvals instead need an approval secret, minted by `POST /v1/approval-session`
 * against a pairing code that exists only in server memory and on the terminal that started
 * the server. The secret is returned once and kept only as a hash, in memory.
 */
export class ApprovalAuthority {
  readonly #code: string;
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;
  readonly #maxFailures: number;
  readonly #now: () => Date;
  #failures = 0;
  #lockouts = 0;
  #lockedUntil = 0;

  constructor(o: ApprovalOptions = {}) {
    this.#code = o.pairingCode ?? newPairingCode();
    this.#ttlMs = o.ttlMs ?? 12 * 60 * 60 * 1000;
    this.#maxFailures = o.maxFailures ?? 5;
    this.#now = o.now ?? (() => new Date());
    o.onPairingCode?.(this.#code);
  }

  /**
   * Mints a session for a correct pairing code. Throws 403, or 429 while locked: every
   * `maxFailures` wrong codes lock minting for 60 s, doubling with each lockout (review m3), so a
   * bearer holder can slow approvals down but not disable them until restart.
   */
  mint(pairingCode: string, channel: ApprovalChannel) {
    const now = this.#now().getTime();
    if (now < this.#lockedUntil)
      throw new ApiError(
        429,
        "approval_locked",
        `too many wrong pairing codes; try again in ${Math.ceil((this.#lockedUntil - now) / 1000)} s`,
      );
    const ok = timingSafeEqual(sha256(normalize(pairingCode)), sha256(normalize(this.#code)));
    if (!ok) {
      if (++this.#failures >= this.#maxFailures) {
        this.#lockedUntil = now + 60_000 * 2 ** this.#lockouts++;
        this.#failures = 0;
      }
      throw new ApiError(403, "approval_pairing_failed", "the pairing code is not correct");
    }
    // Expired sessions are dropped (review m4).
    for (const [hash, session] of this.#sessions)
      if (session.expiresAt <= now) this.#sessions.delete(hash);
    const secret = randomBytes(32).toString("base64url");
    const id = `aps_${randomBytes(6).toString("hex")}`;
    const principal = `local:${osUser()}/${channel}#${id}`;
    const expiresAt = this.#now().getTime() + this.#ttlMs;
    this.#sessions.set(sha256(secret).toString("hex"), { id, principal, expiresAt });
    return { approvalSecret: secret, principal, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Sessions not yet expired or pruned. */
  activeSessions(): number {
    return this.#sessions.size;
  }

  /** The principal behind a valid approval secret on the request; throws 403 otherwise. */
  require(req: FastifyRequest): string {
    const raw = req.headers[APPROVAL_HEADER];
    const secret = Array.isArray(raw) ? raw[0] : raw;
    const session = secret ? this.#sessions.get(sha256(secret).toString("hex")) : undefined;
    if (!session || session.expiresAt <= this.#now().getTime()) {
      throw new ApiError(
        403,
        "approval_required",
        `approvals need a valid ${APPROVAL_HEADER} approval secret (POST /v1/approval-session with the pairing code from the server terminal)`,
      );
    }
    return session.principal;
  }
}

function osUser(): string {
  try {
    return userInfo().username.replace(/[^\w.-]/g, "_") || "user";
  } catch {
    return "user";
  }
}
