import {
  MimirError,
  type Crew,
  type CrewId,
  type SessionId,
  type TaskId,
  type Timestamp,
} from "@mimir/protocol";
import type { ExpireDecision } from "./decisions.js";
import { toIso, toMs } from "./time.js";

/** A time-bounded claim by a crew (and, once started, a session) on a task. */
export interface Lease {
  taskId: TaskId;
  /** Null between grant and session start. */
  sessionId: SessionId | null;
  crewId: CrewId;
  expiresAt: Timestamp;
  heartbeatAt: Timestamp;
}

export const DEFAULT_LEASE_MS = 300_000;

export function leaseTtlMs(crew: Pick<Crew, "limits">): number {
  const s = crew.limits.leaseSeconds;
  return s === undefined ? DEFAULT_LEASE_MS : s * 1000;
}

/** A lease is expired once `now >= expiresAt`. */
function isExpired(lease: Pick<Lease, "expiresAt">, now: Date): boolean {
  return now.getTime() >= toMs(lease.expiresAt);
}

function checkTtl(ttlMs: number): void {
  if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) {
    throw new MimirError("validation_failed", `lease ttl must be > 0, got ${ttlMs}`, { ttlMs });
  }
}

/** Returns a new lease list with a lease for `taskId`. An expired lease for the task is replaced; a live one is a conflict. */
function grant(
  leases: readonly Lease[],
  claim: Pick<Lease, "taskId" | "crewId" | "sessionId">,
  now: Date,
  ttlMs: number,
): Lease[] {
  checkTtl(ttlMs);
  const existing = leases.find((l) => l.taskId === claim.taskId);
  if (existing && !isExpired(existing, now)) {
    throw new MimirError("conflict", `task ${claim.taskId} already has a live lease`, {
      taskId: claim.taskId,
      expiresAt: existing.expiresAt,
    });
  }
  const lease: Lease = {
    taskId: claim.taskId,
    crewId: claim.crewId,
    sessionId: claim.sessionId,
    heartbeatAt: toIso(now.getTime()),
    expiresAt: toIso(now.getTime() + ttlMs),
  };
  return [...leases.filter((l) => l.taskId !== claim.taskId), lease];
}

/**
 * Extends a live lease to now + ttl. Throws not_found if there is no lease,
 * conflict if it already expired or belongs to another session. A lease with
 * no session yet is bound to `sessionId`.
 */
function heartbeat(
  leases: readonly Lease[],
  taskId: TaskId,
  now: Date,
  ttlMs: number,
  sessionId?: SessionId,
): Lease[] {
  checkTtl(ttlMs);
  const existing = leases.find((l) => l.taskId === taskId);
  if (!existing) throw new MimirError("not_found", `no lease for task ${taskId}`, { taskId });
  if (isExpired(existing, now)) {
    throw new MimirError("conflict", `lease for task ${taskId} expired at ${existing.expiresAt}`, {
      taskId,
      expiresAt: existing.expiresAt,
    });
  }
  if (sessionId !== undefined && existing.sessionId !== null && existing.sessionId !== sessionId) {
    throw new MimirError("conflict", `lease for task ${taskId} is held by another session`, {
      taskId,
      sessionId: existing.sessionId,
    });
  }
  const renewed: Lease = {
    ...existing,
    sessionId: existing.sessionId ?? sessionId ?? null,
    heartbeatAt: toIso(now.getTime()),
    expiresAt: toIso(now.getTime() + ttlMs),
  };
  return leases.map((l) => (l.taskId === taskId ? renewed : l));
}

/** Splits leases into live ones and expire decisions, ordered by (expiresAt, taskId). */
function expire(
  leases: readonly Lease[],
  now: Date,
): { leases: Lease[]; decisions: ExpireDecision[] } {
  const expired = leases
    .filter((l) => isExpired(l, now))
    .sort((a, b) => toMs(a.expiresAt) - toMs(b.expiresAt) || cmp(a.taskId, b.taskId));
  return {
    leases: leases.filter((l) => !isExpired(l, now)),
    decisions: expired.map((l) => ({ kind: "expire", taskId: l.taskId })),
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const leaseManager = { grant, heartbeat, expire, isExpired } as const;
