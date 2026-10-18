import { recordedArtifacts } from "../gates/evidence.js";
import type { GateResult } from "../gates/gate-runner.js";
import type { ContextReader, ExecutionReader, IntakeView } from "../gates/ports.js";
import type { DeliveryReport, PrDelivery } from "../report/delivery-report.js";
import type { ReviewRecord } from "../review/review-orchestrator.js";

export interface TraceEvent {
  id: string;
  type: string;
  occurredAt: string;
  /** Envelope source and provenance (e.g. `mimir.server`, `observed`); `null` when unknown. */
  source: string | null;
  provenance: string | null;
}

export interface TraceArtifact {
  id: string;
  kind: string;
  uri: string;
  hash: string;
  /** The `artifact.recorded` event. */
  eventId: string;
}

export interface TraceReview {
  reviewId: string;
  ofPlanTaskId: string;
  status: string;
  verdict: string | null;
  reviewArtifactId: string | null;
}

export interface TraceDocument {
  schemaVersion: 1;
  delivery: {
    id: string;
    status: string;
    createdAt: string;
    deliveredAt: string | null;
    prs: PrDelivery["prs"];
  };
  ticket: IntakeView | null;
  spec: {
    id: string;
    lineageId: string;
    version: number;
    title: string;
    status: string;
    acceptanceCriteria: string[];
  };
  plan: {
    id: string;
    lineageId: string | null;
    version: number;
    specId: string;
    specVersion: number;
  };
  mission: { id: string };
  execution: { id: string; status: string };
  tasks: {
    planTaskId: string;
    mimirTaskId: string | null;
    role: string;
    status: string;
    attempts: number;
    acceptanceCriteria: string[];
    harness: { id: string; version: string; lockDigest: string };
    gate: { evaluationId: string; passed: boolean; evaluatedAt: string } | null;
    /** Reviews this task performed (as the reviewer). */
    reviews: TraceReview[];
    events: TraceEvent[];
    artifacts: TraceArtifact[];
  }[];
  /** Review tasks Sindri added to the mission (not in the plan). */
  reviewTasks: {
    mimirTaskId: string;
    review: TraceReview;
    events: TraceEvent[];
    artifacts: TraceArtifact[];
  }[];
  /** Mission-level events and events of tasks Sindri does not know. */
  unattributedEvents: TraceEvent[];
}

export class TraceError extends Error {
  override readonly name = "TraceError";
}

export interface DeliveryTracerOptions {
  executions: ExecutionReader;
  context: ContextReader;
  reports: {
    get(deliveryId: string): DeliveryReport | undefined;
    prRequests?(deliveryId: string): PrDelivery["prs"];
  };
  gates?: { latest(executionId: string, planTaskId: string): GateResult | undefined };
  reviews?: { list(executionId: string): ReviewRecord[] };
}

/**
 * One JSON document per delivery: ticket -> spec version -> plan version -> Mimir mission ->
 * tasks -> events -> artifacts. Every recorded Mimir event appears exactly once.
 */
export class DeliveryTracer {
  readonly #o: DeliveryTracerOptions;

  constructor(options: DeliveryTracerOptions) {
    this.#o = options;
  }

  async trace(deliveryId: string): Promise<TraceDocument> {
    const report = this.#o.reports.get(deliveryId);
    if (!report) throw new TraceError(`unknown delivery ${deliveryId}`);
    const execution = await this.#o.executions.execution(report.executionId);
    if (!execution) throw new TraceError(`unknown execution ${report.executionId}`);
    const plan = execution.plan;
    const spec = await this.#o.context.spec(plan.specId);
    if (!spec) throw new TraceError(`unknown specification ${plan.specId}`);
    const ticket = spec.intakeId ? ((await this.#o.context.intake(spec.intakeId)) ?? null) : null;
    const execTasks = await this.#o.executions.tasks(execution.id);
    const events = await this.#o.executions.events(execution.id);
    const artifacts = recordedArtifacts(events);
    const reviews = this.#o.reviews?.list(execution.id) ?? [];

    const toEvent = (e: (typeof events)[number]): TraceEvent => ({
      id: e.mimirEventId,
      type: e.type,
      occurredAt: e.occurredAt,
      source: e.source,
      provenance: e.provenance,
    });
    const artifactsOf = (mimirTaskId: string): TraceArtifact[] =>
      artifacts
        .filter((a) => a.taskId === mimirTaskId)
        .map((a) => ({
          id: a.artifactId,
          kind: a.kind,
          uri: a.uri,
          hash: a.hash,
          eventId: a.eventId,
        }));
    const toReview = (r: ReviewRecord): TraceReview => ({
      reviewId: r.id,
      ofPlanTaskId: r.planTaskId,
      status: r.status,
      verdict: r.verdict,
      reviewArtifactId: r.reviewArtifactId,
    });

    const claimed = new Set<string>();
    const eventsOf = (mimirTaskId: string | null) => {
      if (!mimirTaskId) return [];
      const own = events.filter((e) => e.mimirTaskId === mimirTaskId);
      for (const e of own) claimed.add(e.mimirEventId);
      return own.map(toEvent);
    };

    const tasks: TraceDocument["tasks"] = plan.tasks.map((pt) => {
      const et = execTasks.find((t) => t.planTaskId === pt.id);
      const gate = this.#o.gates?.latest(execution.id, pt.id);
      const mimirTaskId = et?.mimirTaskId ?? null;
      return {
        planTaskId: pt.id,
        mimirTaskId,
        role: pt.role,
        status: et?.status ?? "unknown",
        attempts: et?.attempts ?? 0,
        acceptanceCriteria: pt.acceptanceCriteria,
        harness: { id: pt.harnessId, version: pt.harnessVersion, lockDigest: pt.harnessLockDigest },
        gate: gate
          ? { evaluationId: gate.evaluationId, passed: gate.passed, evaluatedAt: gate.evaluatedAt }
          : null,
        reviews: reviews.filter((r) => r.reviewerTaskId === mimirTaskId).map(toReview),
        events: eventsOf(mimirTaskId),
        artifacts: mimirTaskId ? artifactsOf(mimirTaskId) : [],
      };
    });
    const planned = new Set(execTasks.map((t) => t.mimirTaskId));
    const reviewTasks: TraceDocument["reviewTasks"] = reviews
      .filter((r) => !planned.has(r.reviewerTaskId))
      .map((r) => ({
        mimirTaskId: r.reviewerTaskId,
        review: toReview(r),
        events: eventsOf(r.reviewerTaskId),
        artifacts: artifactsOf(r.reviewerTaskId),
      }));

    return {
      schemaVersion: 1,
      delivery: {
        id: report.id,
        status: report.status,
        createdAt: report.createdAt,
        deliveredAt: report.deliveredAt,
        prs: this.#o.reports.prRequests?.(report.id) ?? [],
      },
      ticket,
      spec: {
        id: spec.id,
        lineageId: spec.lineageId,
        version: spec.version,
        title: spec.title,
        status: spec.status,
        acceptanceCriteria: spec.acceptanceCriteria.map((a) => a.id),
      },
      plan: {
        id: plan.id,
        lineageId: plan.lineageId ?? null,
        version: plan.version,
        specId: plan.specId,
        specVersion: plan.specVersion,
      },
      mission: { id: execution.mimirMissionId },
      execution: { id: execution.id, status: execution.status },
      tasks,
      reviewTasks,
      unattributedEvents: events.filter((e) => !claimed.has(e.mimirEventId)).map(toEvent),
    };
  }
}
