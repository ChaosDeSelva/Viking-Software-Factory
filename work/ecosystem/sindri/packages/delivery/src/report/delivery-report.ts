import { randomUUID } from "node:crypto";
import { ensureQualitySchema } from "../schema.js";
import {
  createDataNonce,
  dataRules,
  ProviderError,
  wrapUntrusted,
  type LlmProvider,
} from "@sindri/director";
import type { SqliteDatabase } from "@sindri/knowledge";
import { parseVerificationReport, type GateFailure } from "../gates/brokkr-report.js";
import {
  evidenceTrust,
  isTrusted,
  readVerifiedArtifact,
  recordedArtifacts,
  testRuns,
  type EvidenceTrust,
  type RecordedArtifact,
} from "../gates/evidence.js";
import type { GateResult } from "../gates/gate-runner.js";
import type {
  ArtifactContentReader,
  ContextReader,
  ExecutionEventView,
  ExecutionReader,
  MimirActions,
  PrRequestResult,
} from "../gates/ports.js";
import type { ReviewFinding, ReviewRecord } from "../review/review-orchestrator.js";
import { validateCitations, type CitedSentence, type StrippedSentence } from "./citations.js";

/** A JSON manifest of changed files (`{ files: [{ path, status? }] }` or `string[]`). */
export const CHANGED_FILES_KIND = "changed-files";
export const SCREENSHOT_KIND_PREFIX = "screenshot";

export type DeliveryStatus = "built" | "delivered_pending_merge";
export type RequirementStatus = "satisfied" | "unsatisfied" | "unverified";

export interface DeliveryReport {
  id: string;
  executionId: string;
  projectId: string;
  status: DeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
  spec: { id: string; lineageId: string; version: number; title: string; intakeId: string | null };
  plan: { id: string; version: number };
  missionId: string;
  requirements: {
    criterionId: string;
    text: string;
    verification: string;
    status: RequirementStatus;
    tasks: { planTaskId: string; mimirTaskId: string | null; gatePassed: boolean | null }[];
    /** Mimir event and artifact ids backing the criterion. */
    evidence: string[];
  }[];
  tasks: {
    planTaskId: string;
    mimirTaskId: string | null;
    role: string;
    status: string;
    harness: { id: string; version: string; lockDigest: string };
    gate: {
      evaluationId: string;
      passed: boolean;
      failures: GateFailure[];
      advisories: GateFailure[];
    } | null;
    brokkr: {
      verdict: string;
      reportArtifactId: string;
      commitSha: string;
      checks: { id: string; state: string; required: boolean; exitCode: number | null }[];
    } | null;
  }[];
  summary: { sentences: CitedSentence[]; stripped: StrippedSentence[] };
  changedFiles: {
    planTaskId: string | null;
    path: string;
    status: string | null;
    artifactId: string;
  }[];
  testResults: {
    eventId: string;
    planTaskId: string | null;
    command: string;
    passed: boolean;
    exitCode: number | null;
    durationMs: number | null;
  }[];
  screenshots: {
    artifactId: string;
    planTaskId: string | null;
    kind: string;
    uri: string;
    sha256: string;
  }[];
  reviews: {
    reviewId: string;
    planTaskId: string;
    role: string;
    verdict: string | null;
    reason: string | null;
    findings: ReviewFinding[];
    reviewArtifactId: string | null;
  }[];
  limitations: string[];
  rollback: {
    branches: { planTaskId: string; branch: string; baseSha: string; worktreePath: string }[];
    commits: { eventId: string; planTaskId: string | null; sha: string; branch: string }[];
    note: string;
  };
}

export interface PrDelivery {
  deliveryId: string;
  status: DeliveryStatus;
  prs: {
    planTaskId: string;
    mimirTaskId: string;
    status: PrRequestResult["status"];
    /** The head commit the PR was requested for (`null` on rows from before fix round 1). */
    headSha: string | null;
    approvalId?: string;
  }[];
}

export type DeliveryErrorCode =
  | "unknown_execution"
  | "unknown_spec"
  | "unknown_delivery"
  | "gates_not_passed"
  | "nothing_to_deliver";

export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  constructor(
    readonly code: DeliveryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DeliveryReportsOptions {
  db: SqliteDatabase;
  executions: ExecutionReader;
  mimir: MimirActions;
  content: ArtifactContentReader;
  context: ContextReader;
  /** Used for the implementation summary only, from evidence text only. */
  provider: LlmProvider;
  gates: { latest(executionId: string, planTaskId: string): GateResult | undefined };
  reviews: { list(executionId: string): ReviewRecord[] };
  /** Roles whose worktrees become PRs. Default implementer and docs. */
  prRoles?: readonly string[];
  maxSummaryTokens?: number;
  /** Envelope sources accepted as evidence. Default `["mimir.server"]`. */
  trustedSources?: readonly string[];
  now?: () => Date;
}

interface DeliveryRow {
  id: string;
  execution_id: string;
  project_id: string;
  status: DeliveryStatus;
  report_json: string;
  created_at: string;
  delivered_at: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export const SUMMARY_PURPOSE = "delivery_summary";

export const summarySystem = (nonce: string) =>
  `You write the implementation summary of a software delivery report from recorded evidence.

${dataRules(nonce)}

Rules:
1. Use only facts stated in the evidence blocks. Do not speculate, praise or add anything else.
2. End every sentence with one or more citations of the form [ref:<id>], using the exact id attribute of the evidence block(s) it relies on. Sentences without valid citations are deleted.
3. Plain sentences only, at most 8. No headings, lists or markdown.`;

const ROLLBACK_NOTE =
  "Nothing is merged by Sindri. To roll back, close the pull request(s) and delete the listed branches; each base SHA is the state before the change.";

/**
 * Builds structured delivery reports from Mimir evidence, renders PR text, and asks Mimir for
 * pull requests (approval-gated on Mimir's side). Sindri never pushes or merges.
 */
export class DeliveryReports {
  readonly #db: SqliteDatabase;
  readonly #o: DeliveryReportsOptions;
  readonly #now: () => Date;
  readonly #trust: EvidenceTrust;

  constructor(options: DeliveryReportsOptions) {
    this.#o = options;
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#trust = evidenceTrust(options.trustedSources);
    ensureQualitySchema(this.#db);
  }

  async build(executionId: string): Promise<DeliveryReport> {
    const execution = await this.#o.executions.execution(executionId);
    if (!execution)
      throw new DeliveryError("unknown_execution", `unknown execution ${executionId}`);
    const plan = execution.plan;
    const spec = await this.#o.context.spec(plan.specId);
    if (!spec) throw new DeliveryError("unknown_spec", `unknown specification ${plan.specId}`);
    const execTasks = await this.#o.executions.tasks(executionId);
    const events = await this.#o.executions.events(executionId);
    // Only evidence Mimir itself recorded counts (agent and summary events never do).
    const trusted = events.filter((e) => isTrusted(e, this.#trust));
    const artifacts = recordedArtifacts(trusted, this.#trust);
    const planTaskOf = new Map(execTasks.map((t) => [t.mimirTaskId, t.planTaskId]));
    const planIdOf = (mimirTaskId: string | null) =>
      mimirTaskId === null ? null : (planTaskOf.get(mimirTaskId) ?? null);
    const limitations: string[] = [];

    // Per-task verdicts --------------------------------------------------------------------------
    const tasks: DeliveryReport["tasks"] = [];
    for (const pt of plan.tasks) {
      const et = execTasks.find((t) => t.planTaskId === pt.id);
      const gate = this.#o.gates.latest(executionId, pt.id);
      let brokkr: DeliveryReport["tasks"][number]["brokkr"] = null;
      if (gate?.engineering) {
        const read = await readVerifiedArtifact(
          this.#o.mimir,
          this.#o.content,
          gate.engineering.reportArtifactId,
        );
        const parsed = read.ok ? parseVerificationReport(read.text) : null;
        if (parsed?.ok) {
          brokkr = {
            verdict: parsed.value.verdict,
            reportArtifactId: gate.engineering.reportArtifactId,
            commitSha: parsed.value.repository.commitSha,
            checks: parsed.value.checks.map((c) => ({
              id: c.id,
              state: c.state,
              required: c.required ?? true,
              exitCode: c.exitCode ?? null,
            })),
          };
          const excepted = parsed.value.exceptions.map((e) => e.appliedTo?.checkId ?? e.id);
          if (excepted.length > 0) {
            limitations.push(`${pt.id}: Brokkr approved exceptions for ${excepted.join(", ")}`);
          }
        } else {
          limitations.push(`${pt.id}: Brokkr report could not be re-read for this report`);
        }
      }
      if (!gate) limitations.push(`${pt.id}: quality gates not evaluated`);
      else if (!gate.passed) {
        limitations.push(
          `${pt.id}: quality gates not passed (${gate.failures.map((f) => `${f.gateId}: ${f.reason}`).join(", ")})`,
        );
      }
      for (const a of gate?.advisories ?? []) {
        limitations.push(`${pt.id}: advisory gate ${a.gateId}: ${a.reason}`);
      }
      tasks.push({
        planTaskId: pt.id,
        mimirTaskId: et?.mimirTaskId ?? null,
        role: pt.role,
        status: et?.status ?? "unknown",
        harness: { id: pt.harnessId, version: pt.harnessVersion, lockDigest: pt.harnessLockDigest },
        gate: gate
          ? {
              evaluationId: gate.evaluationId,
              passed: gate.passed,
              failures: gate.failures,
              advisories: gate.advisories,
            }
          : null,
        brokkr,
      });
    }

    // Evidence collections -----------------------------------------------------------------------
    const runs = testRuns(trusted, this.#trust);
    const testResults: DeliveryReport["testResults"] = runs.map((r) => ({
      eventId: r.eventId,
      planTaskId: planIdOf(r.taskId),
      command: r.command,
      passed: r.passed,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
    }));
    if (testResults.some((r) => r.planTaskId === null)) {
      limitations.push("some test runs are not attributed to a task and satisfy no gate");
    }
    const screenshots = artifacts
      .filter((a) => a.kind.startsWith(SCREENSHOT_KIND_PREFIX))
      .map((a) => ({
        artifactId: a.artifactId,
        planTaskId: planIdOf(a.taskId),
        kind: a.kind,
        uri: a.uri,
        sha256: a.hash,
      }));
    const heads: ManifestHead[] = [];
    const changedFiles = await this.#changedFiles(
      artifacts.filter((a) => a.kind === CHANGED_FILES_KIND),
      planIdOf,
      limitations,
      heads,
    );
    const reviewRecords = this.#o.reviews.list(executionId).filter((r) => r.status === "completed");
    const reviews: DeliveryReport["reviews"] = reviewRecords.map((r) => ({
      reviewId: r.id,
      planTaskId: r.planTaskId,
      role: r.role,
      verdict: r.verdict,
      reason: r.reason,
      findings: r.findings,
      reviewArtifactId: r.reviewArtifactId,
    }));
    for (const r of reviews.filter((x) => x.verdict !== "approve")) {
      limitations.push(
        `${r.planTaskId}: independent review requested changes (${r.reason ?? "findings"})`,
      );
    }
    const rollback = rollbackOf(trusted, planIdOf, heads);

    // Requirement links --------------------------------------------------------------------------
    const requirements: DeliveryReport["requirements"] = spec.acceptanceCriteria.map((ac) => {
      const linked = tasks.filter((t) =>
        plan.tasks.find((p) => p.id === t.planTaskId)?.acceptanceCriteria.includes(ac.id),
      );
      const evidence = new Set<string>();
      for (const t of linked) {
        if (t.brokkr) evidence.add(t.brokkr.reportArtifactId);
        for (const r of testResults)
          if (r.planTaskId === t.planTaskId && r.passed) evidence.add(r.eventId);
        for (const r of reviews) {
          if (r.planTaskId === t.planTaskId && r.reviewArtifactId) evidence.add(r.reviewArtifactId);
        }
      }
      const status: RequirementStatus =
        linked.length > 0 && linked.every((t) => t.gate?.passed === true)
          ? "satisfied"
          : linked.some((t) => t.gate?.passed === false)
            ? "unsatisfied"
            : "unverified";
      if (status !== "satisfied") limitations.push(`${ac.id} is ${status}: ${ac.text}`);
      return {
        criterionId: ac.id,
        text: ac.text,
        verification: ac.verification,
        status,
        tasks: linked.map((t) => ({
          planTaskId: t.planTaskId,
          mimirTaskId: t.mimirTaskId,
          gatePassed: t.gate ? t.gate.passed : null,
        })),
        evidence: [...evidence],
      };
    });

    // Summary (provider, evidence only) ----------------------------------------------------------
    const summary = await this.#summary(
      tasks,
      testResults,
      reviewRecords,
      events,
      planIdOf,
      limitations,
    );

    const row: DeliveryRow = {
      id: `dlv_${randomUUID()}`,
      execution_id: executionId,
      project_id: plan.projectId,
      status: "built",
      report_json: "",
      created_at: this.#now().toISOString(),
      delivered_at: null,
    };
    const report: DeliveryReport = {
      id: row.id,
      executionId,
      projectId: plan.projectId,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: null,
      spec: {
        id: spec.id,
        lineageId: spec.lineageId,
        version: spec.version,
        title: spec.title,
        intakeId: spec.intakeId,
      },
      plan: { id: plan.id, version: plan.version },
      missionId: execution.mimirMissionId,
      requirements,
      tasks,
      summary,
      changedFiles,
      testResults,
      screenshots,
      reviews,
      limitations,
      rollback,
    };
    row.report_json = JSON.stringify(report);
    this.#db
      .prepare(
        `INSERT INTO deliveries (id, execution_id, project_id, status, report_json, created_at, delivered_at)
         VALUES (@id, @execution_id, @project_id, @status, @report_json, @created_at, @delivered_at)`,
      )
      .run(row);
    return report;
  }

  get(deliveryId: string): DeliveryReport | undefined {
    const row = this.#db.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId) as
      DeliveryRow | undefined;
    return row && fromRow(row);
  }

  latestFor(executionId: string): DeliveryReport | undefined {
    const row = this.#db
      .prepare("SELECT * FROM deliveries WHERE execution_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(executionId) as DeliveryRow | undefined;
    return row && fromRow(row);
  }

  prRequests(deliveryId: string): PrDelivery["prs"] {
    return (
      this.#db
        .prepare(
          "SELECT plan_task_id, mimir_task_id, status, approval_id, head_sha FROM pr_requests WHERE delivery_id = ? ORDER BY rowid",
        )
        .all(deliveryId) as {
        plan_task_id: string;
        mimir_task_id: string;
        status: PrRequestResult["status"];
        approval_id: string | null;
        head_sha: string | null;
      }[]
    ).map((r) => ({
      planTaskId: r.plan_task_id,
      mimirTaskId: r.mimir_task_id,
      status: r.status,
      headSha: r.head_sha,
      ...(r.approval_id ? { approvalId: r.approval_id } : {}),
    }));
  }

  /**
   * Requires every plan task's latest gate evaluation to have passed, builds a fresh report and
   * asks Mimir for one PR per delivering task's worktree. Status `delivered_pending_merge`.
   */
  async requestPr(executionId: string): Promise<PrDelivery> {
    const existing = this.latestFor(executionId);
    if (existing?.status === "delivered_pending_merge") {
      return {
        deliveryId: existing.id,
        status: existing.status,
        prs: this.prRequests(existing.id),
      };
    }
    const execution = await this.#o.executions.execution(executionId);
    if (!execution)
      throw new DeliveryError("unknown_execution", `unknown execution ${executionId}`);
    const blocked = execution.plan.tasks.filter(
      (t) => this.#o.gates.latest(executionId, t.id)?.passed !== true,
    );
    if (blocked.length > 0) {
      throw new DeliveryError(
        "gates_not_passed",
        `quality gates have not passed for: ${blocked.map((t) => t.id).join(", ")}`,
      );
    }

    const report = existing ?? (await this.build(executionId));
    const prRoles = this.#o.prRoles ?? ["implementer", "docs"];
    const targets = report.tasks.filter(
      (t) =>
        t.mimirTaskId !== null &&
        prRoles.includes(t.role) &&
        report.rollback.branches.some((b) => b.planTaskId === t.planTaskId),
    );
    if (targets.length === 0) {
      throw new DeliveryError("nothing_to_deliver", "no delivering task has a worktree branch");
    }
    const body = renderPrDescription(report);
    const prs: PrDelivery["prs"] = [];
    for (const t of targets) {
      // The head Mimir observed for this task (else its base): the PR is for exactly that state.
      const headSha =
        report.rollback.commits.filter((c) => c.planTaskId === t.planTaskId).at(-1)?.sha ??
        report.rollback.branches.find((b) => b.planTaskId === t.planTaskId)!.baseSha;
      const done = this.#db
        .prepare(
          `SELECT status, approval_id FROM pr_requests
           WHERE execution_id = ? AND plan_task_id = ? AND head_sha = ?`,
        )
        .get(executionId, t.planTaskId, headSha) as
        { status: PrRequestResult["status"]; approval_id: string | null } | undefined;
      let result: PrRequestResult;
      if (done?.status === "requested") {
        result = {
          status: done.status,
          ...(done.approval_id ? { approvalId: done.approval_id } : {}),
        };
      } else {
        result = await this.#o.mimir.requestPr(
          t.mimirTaskId!,
          { title: `${report.spec.title} (${t.planTaskId})`, body },
          `sindri:pr:${executionId}:${t.planTaskId}:${headSha}`,
        );
        this.#db
          .prepare(
            `INSERT OR REPLACE INTO pr_requests (id, delivery_id, project_id, execution_id, plan_task_id,
               mimir_task_id, head_sha, status, approval_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `prq_${randomUUID()}`,
            report.id,
            report.projectId,
            executionId,
            t.planTaskId,
            t.mimirTaskId,
            headSha,
            result.status,
            result.approvalId ?? null,
            this.#now().toISOString(),
          );
      }
      prs.push({
        planTaskId: t.planTaskId,
        mimirTaskId: t.mimirTaskId!,
        status: result.status,
        headSha,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      });
    }
    if (prs.some((p) => p.status === "awaiting_approval"))
      return { deliveryId: report.id, status: "built", prs };
    this.#db
      .prepare(
        "UPDATE deliveries SET status = 'delivered_pending_merge', delivered_at = ? WHERE id = ?",
      )
      .run(this.#now().toISOString(), report.id);
    return { deliveryId: report.id, status: "delivered_pending_merge", prs };
  }

  // -------------------------------------------------------------------------------------------

  async #changedFiles(
    manifests: RecordedArtifact[],
    planIdOf: (id: string | null) => string | null,
    limitations: string[],
    heads: ManifestHead[],
  ): Promise<DeliveryReport["changedFiles"]> {
    const out: DeliveryReport["changedFiles"] = [];
    for (const m of manifests) {
      const read = await readVerifiedArtifact(this.#o.mimir, this.#o.content, m.artifactId);
      let entries: unknown[] | null = null;
      if (read.ok) {
        try {
          const raw: unknown = JSON.parse(read.text);
          if (isRecord(raw)) {
            const headSha = str(raw.headSha);
            const baseSha = str(raw.baseSha);
            if (headSha)
              heads.push({ artifactId: m.artifactId, taskId: m.taskId, headSha, baseSha });
          }
          entries = Array.isArray(raw)
            ? raw
            : isRecord(raw) && Array.isArray(raw.files)
              ? raw.files
              : null;
        } catch {
          entries = null;
        }
      }
      if (!entries) {
        limitations.push(`changed-file manifest ${m.artifactId} could not be read`);
        continue;
      }
      for (const e of entries) {
        const path = typeof e === "string" ? e : isRecord(e) ? str(e.path) : null;
        if (!path) continue;
        out.push({
          planTaskId: planIdOf(m.taskId),
          path,
          status: isRecord(e) ? str(e.status) : null,
          artifactId: m.artifactId,
        });
      }
    }
    return out;
  }

  async #summary(
    tasks: DeliveryReport["tasks"],
    testResults: DeliveryReport["testResults"],
    reviews: ReviewRecord[],
    events: ExecutionEventView[],
    planIdOf: (id: string | null) => string | null,
    limitations: string[],
  ): Promise<DeliveryReport["summary"]> {
    const items: { id: string; kind: string; text: string }[] = [];
    for (const t of tasks) {
      if (!t.brokkr) continue;
      items.push({
        id: t.brokkr.reportArtifactId,
        kind: "brokkr_report",
        text: `Brokkr verification for plan task ${t.planTaskId}: verdict ${t.brokkr.verdict}; checks ${t.brokkr.checks.map((c) => `${c.id}=${c.state}`).join(", ")}.`,
      });
    }
    for (const r of testResults) {
      items.push({
        id: r.eventId,
        kind: "test_run",
        text: `Test run for plan task ${r.planTaskId ?? "(unattributed)"}: command "${r.command}", passed ${r.passed}${r.durationMs === null ? "" : `, ${r.durationMs} ms`}.`,
      });
    }
    for (const r of reviews) {
      if (!r.reviewArtifactId) continue;
      items.push({
        id: r.reviewArtifactId,
        kind: "review",
        text: `Independent ${r.role} review of plan task ${r.planTaskId}: verdict ${r.verdict}. Findings: ${r.findings.map((f) => `[${f.severity}] ${f.message}`).join("; ") || "none"}.`,
      });
    }
    for (const e of events) {
      const p = isRecord(e.payload) ? e.payload : {};
      if (e.type === "task.completed" || e.type === "task.failed") {
        items.push({
          id: e.mimirEventId,
          kind: "task",
          text: `Plan task ${planIdOf(e.mimirTaskId) ?? "(unknown)"} ${e.type === "task.completed" ? "completed" : "failed"}.`,
        });
      } else if (e.type === "git.commit_observed") {
        items.push({
          id: e.mimirEventId,
          kind: "commit",
          text: `Commit ${str(p.sha)} on ${str(p.branch)}: ${str(p.message) ?? ""}`,
        });
      }
      // `summary.created` is a model's summary (provenance `summarized`): never evidence (I5).
    }
    if (items.length === 0) {
      limitations.push("implementation summary unavailable (no evidence)");
      return { sentences: [], stripped: [] };
    }

    const nonce = createDataNonce();
    let text: string;
    try {
      const result = await this.#o.provider.complete({
        system: summarySystem(nonce),
        messages: [
          {
            role: "user",
            content: `${items.map((i) => wrapUntrusted(nonce, i.id, i.text, { kind: i.kind })).join("\n")}\n\nWrite the implementation summary.`,
          },
        ],
        maxTokens: this.#o.maxSummaryTokens ?? 800,
        temperature: 0,
        metadata: { purpose: SUMMARY_PURPOSE },
      });
      text = result.text;
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : "error";
      limitations.push(`implementation summary unavailable (${code})`);
      return { sentences: [], stripped: [] };
    }
    const checked = validateCitations(text, new Set(items.map((i) => i.id)));
    const n = checked.stripped.length;
    if (n > 0) {
      limitations.push(
        `${n} summary ${n === 1 ? "sentence was" : "sentences were"} removed: not backed by cited evidence`,
      );
    }
    return { sentences: checked.kept, stripped: checked.stripped };
  }
}

function fromRow(row: DeliveryRow): DeliveryReport {
  return {
    ...(JSON.parse(row.report_json) as DeliveryReport),
    status: row.status,
    deliveredAt: row.delivered_at,
  };
}

/** `headSha`/`baseSha` of a verified `changed-files` manifest (Mimir's server-recorded head). */
interface ManifestHead {
  artifactId: string;
  taskId: string;
  headSha: string;
  baseSha: string | null;
}

function rollbackOf(
  events: ExecutionEventView[],
  planIdOf: (id: string | null) => string | null,
  heads: ManifestHead[],
): DeliveryReport["rollback"] {
  const branches: DeliveryReport["rollback"]["branches"] = [];
  const commits: DeliveryReport["rollback"]["commits"] = [];
  for (const e of events) {
    if (!isRecord(e.payload)) continue;
    const p = e.payload;
    if (e.type === "git.worktree_created") {
      const planTaskId = planIdOf(e.mimirTaskId);
      const branch = str(p.branch);
      const baseSha = str(p.baseSha);
      const path = str(p.path);
      if (planTaskId && branch && baseSha && path) {
        branches.push({ planTaskId, branch, baseSha, worktreePath: path });
      }
    } else if (e.type === "git.commit_observed") {
      const sha = str(p.sha);
      const branch = str(p.branch);
      if (sha && branch)
        commits.push({ eventId: e.mimirEventId, planTaskId: planIdOf(e.mimirTaskId), sha, branch });
    }
  }
  // Mimir never emits `git.commit_observed`; the committed head is the `headSha` of its
  // `changed-files` manifest. A head equal to the base means nothing was committed.
  for (const h of heads) {
    const planTaskId = planIdOf(h.taskId);
    const branch = branches.find((b) => b.planTaskId === planTaskId);
    if (!planTaskId || !branch || h.headSha === (h.baseSha ?? branch.baseSha)) continue;
    commits.push({ eventId: h.artifactId, planTaskId, sha: h.headSha, branch: branch.branch });
  }
  return { branches, commits, note: ROLLBACK_NOTE };
}

/**
 * Untrusted text in markdown: escapes the characters that make links, images, HTML, headings
 * and table cells, and flattens newlines.
 */
const cell = (s: string | number | boolean | null) =>
  String(s ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*[\]()!#|]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, " ");

/** Markdown PR description. Contains only the report's validated content. */
export function renderPrDescription(report: DeliveryReport): string {
  const out: string[] = [];
  out.push(`# ${cell(report.spec.title)}`, "");
  out.push(
    `Spec ${report.spec.id} v${report.spec.version} · plan ${report.plan.id} v${report.plan.version} · Mimir mission ${report.missionId} · delivery ${report.id}`,
    "",
  );
  out.push("## Summary", "");
  if (report.summary.sentences.length === 0) out.push("_No evidence-backed summary._");
  else out.push(report.summary.sentences.map((s) => cell(s.text)).join(" "));
  out.push(
    "",
    "## Requirements",
    "",
    "| Criterion | Status | Tasks | Evidence |",
    "|---|---|---|---|",
  );
  for (const r of report.requirements) {
    out.push(
      `| ${cell(r.criterionId)} | ${r.status} | ${cell(r.tasks.map((t) => t.planTaskId).join(", "))} | ${cell(r.evidence.join(", "))} |`,
    );
  }
  out.push(
    "",
    "## Verification",
    "",
    "| Task | Brokkr verdict | Checks | Gates |",
    "|---|---|---|---|",
  );
  for (const t of report.tasks) {
    out.push(
      `| ${cell(t.planTaskId)} | ${cell(t.brokkr?.verdict ?? "none")} | ${cell(t.brokkr?.checks.map((c) => `${c.id}: ${c.state}`).join(", ") ?? "-")} | ${t.gate ? (t.gate.passed ? "passed" : "failed") : "not evaluated"} |`,
    );
  }
  out.push("", "## Tests", "");
  if (report.testResults.length === 0) out.push("_No recorded test runs._");
  else {
    out.push("| Task | Command | Passed | Exit code | Duration (ms) |", "|---|---|---|---|---|");
    for (const r of report.testResults) {
      out.push(
        `| ${cell(r.planTaskId)} | \`${cell(r.command)}\` | ${r.passed} | ${cell(r.exitCode)} | ${cell(r.durationMs)} |`,
      );
    }
  }
  out.push("", "## Independent review", "");
  if (report.reviews.length === 0) out.push("_No completed review._");
  for (const r of report.reviews) {
    out.push(
      `- ${cell(r.planTaskId)} (${r.role}): **${r.verdict ?? "pending"}**${r.reason ? ` (${cell(r.reason)})` : ""}`,
    );
    for (const f of r.findings) {
      out.push(
        `  - [${f.severity}] ${cell(f.message)}${f.file ? ` (${cell(f.file)}${f.line ? `:${f.line}` : ""})` : ""}`,
      );
    }
  }
  out.push("", "## Screenshots", "");
  if (report.screenshots.length === 0) out.push("_None recorded._");
  for (const s of report.screenshots)
    out.push(`- ${cell(s.kind)}: ${cell(s.uri)} (${cell(s.sha256)})`);
  out.push("", "## Changed files", "");
  if (report.changedFiles.length === 0) out.push("_No changed-file manifest recorded._");
  else {
    out.push("| File | Status | Task |", "|---|---|---|");
    for (const f of report.changedFiles)
      out.push(`| ${cell(f.path)} | ${cell(f.status)} | ${cell(f.planTaskId)} |`);
  }
  out.push("", "## Limitations and unresolved risks", "");
  if (report.limitations.length === 0) out.push("_None identified from the evidence._");
  for (const l of report.limitations) out.push(`- ${cell(l)}`);
  out.push("", "## Rollback", "");
  for (const b of report.rollback.branches) {
    out.push(
      `- ${cell(b.planTaskId)}: branch \`${cell(b.branch)}\` from base \`${cell(b.baseSha)}\``,
    );
  }
  out.push("", report.rollback.note, "");
  out.push(
    "---",
    "_Generated by Sindri from recorded evidence. Sindri never pushes or merges._",
    "",
  );
  return out.join("\n");
}
