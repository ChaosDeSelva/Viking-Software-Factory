import {
  contextReaderFrom,
  DeliveryReports,
  DeliveryTracer,
  executionReaderFor,
  GateRunner,
  mimirActionsFor,
  mimirArtifactContentReader,
  renderPrDescription,
  ReviewOrchestrator,
  type DeliveryLoop,
  type DeliveryReport,
  type DocumentDecision,
  type GateSpec,
  type PlanTaskView,
  type PlanView,
  type PrDiffReader,
  type RepoReader,
  type GateResult,
  type PrDelivery,
  type ReviewRecord,
  type TraceDocument,
} from "@sindri/delivery";
import type { LlmProvider } from "@sindri/director";
import type { Intake } from "@sindri/intake";
import type { SqliteDatabase } from "@sindri/knowledge";
import { MimirClientFacade } from "@sindri/mimir-client";
import type { Specs } from "@sindri/specs";
import type { ExecutionHub, MimirConnection } from "./execution-hub.js";

/**
 * What the server needs from S6 (`@sindri/delivery` gates, review, report and trace):
 *   assess        -> ReviewOrchestrator.requestReview + collect, GateRunner.evaluate,
 *                    DeliveryReports.build (run once an execution is verified)
 *   gateResults   -> GateRunner.latest (stored)
 *   reviews       -> ReviewOrchestrator.list (stored)
 *   report        -> DeliveryReports.latestFor ?? build
 *   renderPrDescription -> renderPrDescription
 *   requestPr     -> DeliveryReports.requestPr (approval-gated on Mimir's side)
 *   decide        -> DeliveryReports.decide (accept or reject a document delivery)
 *   trace         -> DeliveryTracer.trace(deliveryId)
 * Routes address a delivery by its execution id; the S6 delivery id is `report.id`.
 */
export interface DeliveryService {
  readonly kind: "s6" | "custom";
  assess(executionId: string): Promise<void>;
  gateResults(executionId: string): GateResult[];
  reviews(executionId: string): ReviewRecord[];
  report(executionId: string): Promise<DeliveryReport>;
  renderPrDescription(report: DeliveryReport): string;
  requestPr(executionId: string): Promise<PrDelivery>;
  /** Ends a document (research) delivery with a human decision. */
  decide(
    executionId: string,
    input: { decision: DocumentDecision; actor: string; reason?: string },
  ): Promise<DeliveryReport>;
  trace(executionId: string): Promise<TraceDocument>;
}

/**
 * Product gates per plan task. A research plan checks its document and the fact-check's verdict;
 * a change plan reviews implementer work and reads reviewer verdicts.
 */
export function gatesFor(task: PlanTaskView, plan: PlanView): GateSpec[] {
  if (plan.work?.kind === "pr_review")
    return task.role === "reviewer" || task.role === "security"
      ? [{ id: "pr-review", kind: "pr-review", required: true }]
      : [];
  if (plan.work?.kind === "research") {
    if (task.role === "investigator") return [{ id: "research", kind: "research", required: true }];
    if (task.role === "reviewer")
      return [{ id: "review-verdict", kind: "review-artifact", required: true }];
    return [];
  }
  return task.role === "implementer"
    ? [{ id: "independent-review", kind: "review", required: true }]
    : ["reviewer", "qa", "security"].includes(task.role)
      ? [{ id: "review-verdict", kind: "review-artifact", required: true }]
      : [];
}

export interface S6DeliveryOptions {
  db: SqliteDatabase;
  hub: ExecutionHub;
  specs: Specs;
  intake: () => Intake;
  /** LLM provider for the evidence-only implementation summary. */
  provider: () => LlmProvider;
  /** Envelope sources counted as evidence. Default: Mimir's own server (`mimir.server`). */
  trustedSources?: readonly string[];
  /** Reads project repositories to check research file citations. */
  repo?: RepoReader;
  /** Reads a PR review's diff from the review mirror. */
  prDiff?: PrDiffReader;
  now?: () => Date;
}

interface Parts {
  executions: ReturnType<typeof executionReaderFor>;
  gates: GateRunner;
  reviews: ReviewOrchestrator;
  reports: DeliveryReports;
  tracer: DeliveryTracer;
}

/** The S6 services bound to S5's DeliveryLoop and the configured Mimir. */
export class S6DeliveryService implements DeliveryService {
  readonly kind = "s6" as const;
  readonly #o: S6DeliveryOptions;
  /** Stored results only (no Mimir needed): latest gates, review records, reports. */
  readonly #offline: Parts;
  readonly #online = new WeakMap<MimirConnection, Parts>();

  constructor(o: S6DeliveryOptions) {
    this.#o = o;
    this.#offline = this.#parts(o.hub.reader, new MimirClientFacade({ db: o.db }));
  }

  async assess(executionId: string): Promise<void> {
    const p = await this.#connected();
    const execution = this.#o.hub.reader.get(executionId);
    if (!execution) return;
    const plan = (await this.#offline.executions.execution(executionId))?.plan.tasks ?? [];
    // Independent review of every implementer task (adopts the plan's own review task).
    for (const t of plan.filter((x) => x.role === "implementer")) {
      try {
        const existing = p.reviews.latestFor(executionId, t.id);
        const review = existing ?? (await p.reviews.requestReview(executionId, t.id));
        if (!review.completedAt) await p.reviews.collect(review.id);
      } catch {
        // No adoptable review task and Mimir refuses new tasks after completion: the review
        // gate (when configured) and the report show the review as missing.
      }
    }
    for (const t of plan) await p.gates.evaluate(executionId, t.id);
    await p.reports.build(executionId);
  }

  gateResults(executionId: string): GateResult[] {
    const tasks = this.#o.hub.reader.tasks(executionId);
    return tasks
      .map((t) => this.#offline.gates.latest(executionId, t.planTaskId))
      .filter((g): g is GateResult => g !== undefined);
  }

  reviews(executionId: string): ReviewRecord[] {
    return this.#offline.reviews.list(executionId);
  }

  async report(executionId: string): Promise<DeliveryReport> {
    return (
      this.#offline.reports.latestFor(executionId) ??
      (await (await this.#connected()).reports.build(executionId))
    );
  }

  renderPrDescription(report: DeliveryReport): string {
    return renderPrDescription(report);
  }

  async requestPr(executionId: string): Promise<PrDelivery> {
    return (await this.#connected()).reports.requestPr(executionId);
  }

  async decide(
    executionId: string,
    input: { decision: DocumentDecision; actor: string; reason?: string },
  ): Promise<DeliveryReport> {
    // Stored gates and reports are enough; no Mimir call unless no report was built yet.
    const report = this.#offline.reports.latestFor(executionId);
    return (report ? this.#offline : await this.#connected()).reports.decide(executionId, input);
  }

  async trace(executionId: string): Promise<TraceDocument> {
    const report = await this.report(executionId);
    return (await this.#connected()).tracer.trace(report.id);
  }

  async #connected(): Promise<Parts> {
    const conn = await this.#o.hub.connection();
    let parts = this.#online.get(conn);
    if (!parts) {
      parts = this.#parts(conn.loop, conn.facade);
      this.#online.set(conn, parts);
    }
    return parts;
  }

  #parts(loop: Pick<DeliveryLoop, "get" | "tasks" | "events">, facade: MimirClientFacade): Parts {
    const { db } = this.#o;
    const now = {
      ...(this.#o.now ? { now: this.#o.now } : {}),
      ...(this.#o.trustedSources ? { trustedSources: this.#o.trustedSources } : {}),
    };
    const executions = executionReaderFor({ db, loop, mimir: facade });
    const mimir = mimirActionsFor(facade);
    const content = mimirArtifactContentReader(facade);
    const context = contextReaderFrom({ specs: this.#o.specs, intakes: this.#o.intake() });
    const reviews = new ReviewOrchestrator({ db, executions, mimir, content, ...now });
    const gates = new GateRunner({
      db,
      executions,
      mimir,
      content,
      reviews,
      gatesFor,
      ...(this.#o.repo ? { repo: this.#o.repo } : {}),
      ...now,
    });
    // Resolved per call, so provider settings changes apply to cached parts.
    const provider: LlmProvider = {
      name: "settings",
      complete: (req) => this.#o.provider().complete(req),
    };
    const reports = new DeliveryReports({
      db,
      executions,
      mimir,
      content,
      context,
      provider,
      gates,
      reviews,
      ...(this.#o.prDiff ? { prDiff: this.#o.prDiff } : {}),
      ...now,
    });
    const tracer = new DeliveryTracer({ executions, context, reports, gates, reviews });
    return { executions, gates, reviews, reports, tracer };
  }
}
