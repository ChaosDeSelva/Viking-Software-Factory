import {
  ApprovalDecisionSchema,
  MimirError,
  newId,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type MissionId,
  type TaskId,
} from "@mimir/protocol";
import { isPrivilegedAction, type PrivilegedAction } from "./actions.js";
import type { Actor } from "./evaluate.js";
import type { PolicyDomainEvent } from "./events.js";

export interface ApprovalRequestInput {
  action: PrivilegedAction;
  requestedBy: Actor;
  missionId?: MissionId;
  taskId?: TaskId;
  /** Human-readable summary of what will happen if approved. */
  payloadSummary: string;
  ttlMs: number;
}

export interface ApprovalDecisionInput {
  decision: ApprovalDecision;
  actor: Actor;
  reason: string;
}

/** An approval plus the request data the protocol entity does not carry. */
export interface ApprovalRecord {
  approval: Approval;
  requestedBy: Actor;
  payloadSummary: string;
}

export interface ApprovalServiceOptions {
  now: () => Date;
  generateId?: () => ApprovalId;
  /** Existing records to resume from (e.g. loaded from the store). */
  approvals?: Iterable<ApprovalRecord>;
}

/**
 * In-memory approval state machine. No I/O: time comes from `now`, and domain events are
 * buffered for the caller to drain with `takeEvents()` and append.
 *
 * pending -> approved | rejected (via decide, by a human other than the requester, before expiry)
 * pending -> expired (via expire, at or after expiry)
 */
export class ApprovalService {
  private readonly now: () => Date;
  private readonly generateId: () => ApprovalId;
  private readonly records = new Map<ApprovalId, ApprovalRecord>();
  private events: PolicyDomainEvent[] = [];

  constructor(options: ApprovalServiceOptions) {
    this.now = options.now;
    this.generateId = options.generateId ?? (() => newId("apr"));
    for (const r of options.approvals ?? []) {
      this.records.set(r.approval.id, {
        approval: { ...r.approval },
        requestedBy: { ...r.requestedBy },
        payloadSummary: r.payloadSummary,
      });
    }
  }

  request(input: ApprovalRequestInput): Approval {
    if (!isPrivilegedAction(input.action)) {
      throw new MimirError("validation_failed", `unknown privileged action: ${input.action}`);
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new MimirError("validation_failed", "ttlMs must be a positive finite number", {
        ttlMs: input.ttlMs,
      });
    }
    if (input.payloadSummary.trim() === "") {
      throw new MimirError("validation_failed", "payloadSummary must not be empty");
    }
    if (input.requestedBy.id === "") {
      throw new MimirError("validation_failed", "requestedBy.id must not be empty");
    }
    const now = this.now();
    const ts = now.toISOString();
    const expiry = new Date(now.getTime() + input.ttlMs);
    if (Number.isNaN(expiry.getTime())) {
      throw new MimirError("validation_failed", "ttlMs puts the expiry outside the date range", {
        ttlMs: input.ttlMs,
      });
    }
    const approval: Approval = {
      id: this.generateId(),
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      action: input.action,
      status: "pending",
      actor: null,
      expiry: expiry.toISOString(),
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      reason: null,
    };
    this.records.set(approval.id, {
      approval,
      requestedBy: { ...input.requestedBy },
      payloadSummary: input.payloadSummary,
    });
    this.events.push({
      type: "approval.requested",
      payload: {
        approvalId: approval.id,
        action: approval.action,
        expiry: approval.expiry,
        reason: input.payloadSummary,
      },
    });
    return { ...approval };
  }

  decide(id: ApprovalId, input: ApprovalDecisionInput): Approval {
    const record = this.records.get(id);
    if (!record) throw new MimirError("not_found", `approval ${id} not found`, { id });
    const { approval } = record;
    if (!ApprovalDecisionSchema.safeParse(input.decision).success) {
      throw new MimirError("validation_failed", `invalid decision: ${String(input.decision)}`);
    }
    if (approval.status !== "pending") {
      throw new MimirError("invalid_transition", `approval ${id} is already ${approval.status}`, {
        id,
        status: approval.status,
      });
    }
    const now = this.now();
    if (isPastExpiry(approval, now)) {
      throw new MimirError("invalid_transition", `approval ${id} has expired`, {
        id,
        status: "expired",
        expiry: approval.expiry,
      });
    }
    if (input.actor.kind !== "human") {
      throw new MimirError("policy_denied", "only a human may decide an approval", {
        id,
        actorKind: input.actor.kind,
      });
    }
    if (input.actor.id === record.requestedBy.id) {
      throw new MimirError("policy_denied", "the requester cannot decide their own approval", {
        id,
        actor: input.actor.id,
      });
    }
    const next: Approval = {
      ...approval,
      status: input.decision,
      actor: input.actor.id,
      reason: input.reason,
      updatedAt: now.toISOString(),
      version: approval.version + 1,
    };
    this.records.set(id, { ...record, approval: next });
    this.events.push({
      type: "approval.decided",
      payload: {
        approvalId: id,
        decision: input.decision,
        actor: input.actor.id,
        reason: input.reason,
      },
    });
    return { ...next };
  }

  /** Mark every pending approval whose expiry is at or before `now` as expired. */
  expire(now: Date = this.now()): Approval[] {
    const expired: Approval[] = [];
    for (const [id, record] of this.records) {
      const { approval } = record;
      if (approval.status !== "pending" || !isPastExpiry(approval, now)) continue;
      const next: Approval = {
        ...approval,
        status: "expired",
        updatedAt: now.toISOString(),
        version: approval.version + 1,
      };
      this.records.set(id, { ...record, approval: next });
      this.events.push({ type: "approval.expired", payload: { approvalId: id } });
      expired.push({ ...next });
    }
    return expired;
  }

  get(id: ApprovalId): Approval | undefined {
    const r = this.records.get(id);
    return r ? { ...r.approval } : undefined;
  }

  requestedBy(id: ApprovalId): Actor | undefined {
    const r = this.records.get(id);
    return r ? { ...r.requestedBy } : undefined;
  }

  payloadSummary(id: ApprovalId): string | undefined {
    return this.records.get(id)?.payloadSummary;
  }

  /** All approvals in insertion order. */
  list(): Approval[] {
    return [...this.records.values()].map((r) => ({ ...r.approval }));
  }

  /** Return and clear the buffered domain events, oldest first. */
  takeEvents(): PolicyDomainEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

function isPastExpiry(approval: Approval, now: Date): boolean {
  return approval.expiry !== null && Date.parse(approval.expiry) <= now.getTime();
}
