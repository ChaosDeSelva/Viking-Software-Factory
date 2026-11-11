import { ProviderError, type LlmProvider, type LlmUsage } from "@sindri/director";
import { SindriError, type Knowledge, type SqliteDatabase } from "@sindri/knowledge";
import { gatherLearning, learningInputs, type Learning, type LearningLimits } from "./learning.js";
import type {
  ActionContext,
  ApplyResult,
  DeliverySubject,
  EscalationSubject,
  PlanApprovalSubject,
  QuestionSubject,
  SpecApprovalSubject,
  StewardWorld,
} from "./ports.js";
import {
  ACCEPT_AS_IS,
  allowedValues,
  AUTO_ESCALATION_DECISIONS,
  discover,
  heuristic,
  subjectInputs,
  type Candidate,
  type Heuristic,
} from "./producers.js";
import { recommendationRequest } from "./prompt.js";
import { jaccard, tokens } from "./similarity.js";
import { StewardStore, type ListFilter, type StoredDecision } from "./store.js";
import {
  APPROVAL_TYPES,
  type Decision,
  type DecisionType,
  type Guidance,
  type LessonSource,
  type Mode,
  type Note,
  type StewardType,
} from "./types.js";

export interface StewardLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface StewardOptions {
  db: SqliteDatabase;
  world: StewardWorld;
  /** The LLM provider in effect (read per call, so settings changes apply). */
  provider: () => LlmProvider;
  /** Feedback Graph lessons (read-only). */
  lessons?: LessonSource;
  /** Records guidance evidence and entries when the operator accepts a guidance proposal. */
  knowledge?: Pick<Knowledge, "evidence" | "knowledge">;
  now?: () => Date;
  /** Periodic catch-up tick. Default 30 s. */
  tickMs?: number;
  /** Delay between a nudge and its tick (events coalesce). Default 250 ms. */
  nudgeMs?: number;
  /** Auto mode applies only recommendations at least this confident. Default 0.6. */
  autoMinConfidence?: number;
  /** Provider calls per tick at most. Default 10. */
  maxProviderCallsPerTick?: number;
  /** Recommendation attempts per decision before the steward stops retrying. Default 3. */
  maxAttempts?: number;
  /** Consistent corrections that make a guidance proposal. Default 3. */
  correctionThreshold?: number;
  limits?: Partial<LearningLimits>;
  logger?: StewardLogger;
  /** Called after every provider call (cost accounting). */
  onProviderRun?: (run: {
    projectId: string;
    purpose: string;
    model: string;
    usage: LlmUsage | null;
    outcome?: string;
  }) => void;
}

export interface StewardStatus {
  running: boolean;
  types: StewardType[];
}

const STEWARD = "steward";
const CORRECTED = new Set(["changed", "rejected", "rolled_back"]);
const APPLIED = new Set(["accepted", "changed", "applied"]);
const AUTO_APPLY_FAILED = "auto apply failed: ";
/** Word overlap (Jaccard) at which a past subject counts as similar. */
const SIMILAR = 0.3;

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const errorText = (e: unknown): string =>
  e instanceof ProviderError
    ? `${e.code}: ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);

/** A value normalised for comparing corrections (rework text collapses to "change"). */
const norm = (type: DecisionType, v: string): string =>
  type === "rework.suggest" ? (v.trim() === ACCEPT_AS_IS ? ACCEPT_AS_IS : "change") : v.trim();

/**
 * The steward: produces recommendations from what happens in Sindri, records every decision with
 * its inputs, reasoning and outcome, applies them when the operator accepts (or by itself, for
 * types in auto mode that allow it), rolls back what can be rolled back, and proposes guidance
 * from repeated operator corrections. Ticks are serialized, so provider calls run one at a time.
 */
export class Steward {
  readonly store: StewardStore;
  readonly #o: StewardOptions;
  readonly #now: () => Date;
  readonly #busy = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #nudgeTimer: NodeJS.Timeout | undefined;
  #started = false;
  #closed = false;
  #current: Promise<void> = Promise.resolve();
  #queued: Promise<void> | null = null;

  constructor(o: StewardOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.store = new StewardStore(o.db, this.#now);
  }

  // ------------------------------------------------------------------ loop

  /** Starts the periodic tick and runs one at once (catch-up after a restart). */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#timer = setInterval(() => void this.tick(), this.#o.tickMs ?? 30_000);
    this.#timer.unref();
    void this.tick();
  }

  /**
   * Stops the timers and waits for a running tick to finish, at most `closeWaitMs` (default
   * 5 s): a provider call can take minutes, and a tick that ends later only logs its failures.
   */
  async close(closeWaitMs = 5_000): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#nudgeTimer) clearTimeout(this.#nudgeTimer);
    this.#timer = this.#nudgeTimer = undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.#current,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, closeWaitMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  get running(): boolean {
    return this.#started && !this.#closed && !this.store.paused();
  }

  status(): StewardStatus {
    return { running: this.running, types: this.store.types() };
  }

  pause(actor: string): StewardStatus {
    this.store.setPaused(true, actor);
    return this.status();
  }

  resume(actor: string): StewardStatus {
    this.store.setPaused(false, actor);
    this.nudge();
    return this.status();
  }

  setMode(type: DecisionType, mode: Mode, actor: string): StewardType[] {
    if (mode === "auto" && APPROVAL_TYPES.has(type))
      throw new SindriError(
        "validation_failed",
        `${type} is an approval: it can be recommended, never applied automatically`,
      );
    this.store.setMode(type, mode, actor);
    this.nudge();
    return this.store.types();
  }

  /** Something happened in Sindri: tick soon (nudges within `nudgeMs` coalesce). */
  nudge(): void {
    if (this.#closed || !this.#started || this.#nudgeTimer) return;
    this.#nudgeTimer = setTimeout(() => {
      this.#nudgeTimer = undefined;
      void this.tick();
    }, this.#o.nudgeMs ?? 250);
    this.#nudgeTimer.unref();
  }

  /**
   * One cycle: discover subjects, expire decisions whose subject is gone, create and fill
   * recommendations, auto-apply, then record outcomes. Calls while a cycle runs queue one more.
   * Never rejects. Paused: does nothing.
   */
  tick(): Promise<void> {
    if (this.#queued) return this.#queued;
    const run = this.#current.then(async () => {
      this.#queued = null;
      try {
        await this.#cycle();
      } catch (err) {
        this.#o.logger?.warn("steward tick failed", { err: errorText(err) });
      }
    });
    this.#queued = run;
    this.#current = run;
    return run;
  }

  async #cycle(): Promise<void> {
    if (this.#closed || this.store.paused()) return;
    const enabled = (t: DecisionType) => this.store.mode(t) !== "off";
    const { candidates, scanned } = discover(this.#o.world, enabled, (type, err) =>
      this.#o.logger?.warn("steward could not read subjects", { type, err: errorText(err) }),
    );
    const byKey = new Map(candidates.map((c) => [`${c.type}\u0000${c.dedupeKey}`, c]));

    // Subjects that are gone (answered, resolved, approved elsewhere) expire their decisions.
    for (const d of this.store.pending()) {
      if (
        !scanned.has(d.type) ||
        byKey.has(`${d.type}\u0000${d.dedupeKey}`) ||
        this.#busy.has(d.id)
      )
        continue;
      this.store.update(
        d.id,
        { status: "expired", decidedAt: this.#iso() },
        { action: "expired", actor: STEWARD, detail: "the subject is no longer open" },
        { status: "pending" },
      );
    }

    for (const c of candidates) {
      const mode = this.store.mode(c.type);
      this.store.create({
        projectId: c.projectId,
        type: c.type,
        dedupeKey: c.dedupeKey,
        subject: c.subject,
        context: c.data,
        mode: mode === "auto" ? "auto" : "recommend",
      });
    }

    let calls = 0;
    const maxCalls = this.#o.maxProviderCallsPerTick ?? 10;
    for (const d of this.store.pending()) {
      if (this.#closed || this.store.paused()) return;
      const c = byKey.get(`${d.type}\u0000${d.dedupeKey}`);
      if (!c || this.#busy.has(d.id)) continue;
      let cur: StoredDecision | undefined = d;
      if (!d.recommendation.value) {
        if (d.attempts >= (this.#o.maxAttempts ?? 3) || calls >= maxCalls) continue;
        const r = await this.#recommend(d, c);
        if (r.calledProvider) calls++;
        cur = r.decision;
      }
      if (cur?.recommendation.value && this.store.mode(cur.type) === "auto")
        await this.#autoApply(cur, c);
    }

    this.#recordOutcomes();
  }

  // ------------------------------------------------------------------ recommendation

  async #recommend(
    d: StoredDecision,
    c: Candidate,
  ): Promise<{ decision: StoredDecision | undefined; calledProvider: boolean }> {
    const query = [c.subject.label, JSON.stringify(c.data)].join(" ");
    const learning = await gatherLearning({
      store: this.store,
      world: this.#o.world,
      lessons: this.#o.lessons,
      projectId: c.projectId,
      type: c.type,
      query,
      excludeId: d.id,
      ...(this.#o.limits ? { limits: this.#o.limits } : {}),
    });
    const inputs = [...subjectInputs(c), ...learningInputs(learning)];
    const h = heuristic(c);
    // "Similar" compares subjects with subjects: the retrieval score also counts the subject's
    // JSON, which keeps even an identical past subject below any useful threshold.
    const subject = tokens(c.subject.label);
    const similar = learning.past.filter(
      (p) => jaccard(subject, tokens(p.decision.subject.label)) >= SIMILAR,
    );
    const corrected = similar.filter((p) => CORRECTED.has(p.decision.status));
    // The drafter's own suggestion stands unless a similar past answer was corrected.
    const useHeuristic = h !== null && (c.type !== "spec.answer" || corrected.length === 0);
    if (useHeuristic) {
      const rec = enrich(h, learning, similar);
      return {
        decision: this.store.update(
          d.id,
          {
            inputs,
            recommendation: { value: rec.value, detail: rec.detail },
            reasoning: rec.reasoning,
            confidence: rec.confidence,
            error: null,
            attempts: d.attempts + 1,
          },
          { action: "recommended", actor: STEWARD, detail: { source: "heuristic" } },
          { status: "pending" },
        ),
        calledProvider: false,
      };
    }
    const purpose = `steward_${c.type.replace(".", "_")}`;
    let provider: LlmProvider;
    try {
      provider = this.#o.provider();
      const res = await provider.complete(
        recommendationRequest(c, learning, c.type === "spec.answer" ? h : null),
      );
      if (res.parsed === undefined)
        throw new ProviderError("invalid_output", "missing structured output", {
          usage: res.usage,
          model: res.model,
        });
      this.#o.onProviderRun?.({
        projectId: c.projectId,
        purpose,
        model: res.model,
        usage: res.usage,
      });
      const out = res.parsed;
      return {
        decision: this.store.update(
          d.id,
          {
            inputs,
            recommendation: { value: out.value.trim(), detail: out.detail.trim() || undefined },
            reasoning: out.reasoning,
            confidence: out.confidence,
            error: null,
            attempts: d.attempts + 1,
          },
          {
            action: "recommended",
            actor: STEWARD,
            detail: { source: "provider", model: res.model },
          },
          { status: "pending" },
        ),
        calledProvider: true,
      };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : null;
      this.#o.onProviderRun?.({
        projectId: c.projectId,
        purpose,
        model: pe?.model ?? "unknown",
        usage: pe?.usage ?? null,
        outcome: pe?.code ?? "error",
      });
      const message = errorText(err);
      this.#o.logger?.warn("steward recommendation failed", {
        decisionId: d.id,
        type: d.type,
        err: message,
      });
      const updated = this.store.update(
        d.id,
        { inputs, error: message, attempts: d.attempts + 1 },
        { action: "recommend_failed", actor: STEWARD, detail: { error: message } },
        { status: "pending" },
      );
      if (updated)
        this.store.addNote({
          projectId: d.projectId,
          decisionId: d.id,
          author: STEWARD,
          text: `Recommendation failed (attempt ${d.attempts + 1}): ${message}`,
        });
      return { decision: updated && this.store.get(d.id), calledProvider: true };
    }
  }

  // ------------------------------------------------------------------ applying

  async #autoApply(stale: StoredDecision, c: Candidate): Promise<void> {
    // The cycle's snapshot may be stale: the operator can decide while a tick awaits a provider.
    const d = this.store.get(stale.id);
    if (!d || d.status !== "pending" || this.#busy.has(d.id)) return;
    // A failed auto apply is left to the operator, not retried on every tick.
    if (d.error?.startsWith(AUTO_APPLY_FAILED)) return;
    const why =
      autoRefusal(d, this.#o.autoMinConfidence ?? 0.6) ??
      // One automatic retry per task: a task that fails again goes to the operator.
      (d.type === "escalation.resolve" &&
      d.recommendation.value === "retry" &&
      this.store.countApplied(d.type, d.subject.id, "retry", "applied") > 0
        ? "this task was already retried automatically once"
        : null);
    if (why) {
      if (d.mode === "auto")
        this.store.update(
          d.id,
          { mode: "recommend" },
          { action: "auto_skipped", actor: STEWARD, detail: why },
          { status: "pending" },
        );
      return;
    }
    this.#busy.add(d.id);
    try {
      const value = d.recommendation.value;
      const result = await this.#apply(d, c.data, value, { actor: STEWARD });
      this.store.update(
        d.id,
        {
          mode: "auto",
          status: "applied",
          finalValue: value,
          applied: result.data,
          reversible: result.reversible,
          error: null,
          decidedAt: this.#iso(),
        },
        { action: "applied", actor: STEWARD, detail: { value } },
        { status: "pending" },
      );
    } catch (err) {
      const message = errorText(err);
      this.#o.logger?.warn("steward auto apply failed", { decisionId: d.id, err: message });
      this.store.update(
        d.id,
        { mode: "recommend", error: `${AUTO_APPLY_FAILED}${message}` },
        { action: "apply_failed", actor: STEWARD, detail: { error: message } },
        { status: "pending" },
      );
    } finally {
      this.#busy.delete(d.id);
    }
  }

  async #apply(
    d: StoredDecision,
    subject: unknown,
    value: string,
    ctx: ActionContext,
  ): Promise<ApplyResult> {
    const w = this.#o.world;
    switch (d.type) {
      case "spec.answer":
        return w.answerQuestion(subject as QuestionSubject, value, ctx);
      case "escalation.resolve":
        return w.resolveEscalation(
          subject as EscalationSubject,
          value,
          clip(
            `steward decision ${d.id}: ${d.recommendation.detail || d.reasoning || value}`,
            2000,
          ),
          ctx,
        );
      case "rework.suggest":
        if (value.trim() === ACCEPT_AS_IS) return { reversible: false, data: {} };
        return w.draftRework(subject as DeliverySubject, value, ctx);
      case "spec.approve":
        if (value !== "approve") return { reversible: false, data: {} };
        return w.approveSpec(subject as SpecApprovalSubject, ctx);
      case "plan.approve":
        if (value !== "approve") return { reversible: false, data: {} };
        return w.approvePlan(subject as PlanApprovalSubject, ctx);
    }
  }

  // ------------------------------------------------------------------ operator actions

  list(f: ListFilter = {}): Decision[] {
    return this.store.list(f).map(StewardStore.view);
  }

  get(id: string): Decision {
    const d = this.store.get(id, { history: true });
    if (!d) throw new SindriError("not_found", "decision not found");
    return StewardStore.view(d);
  }

  /**
   * The operator accepts a pending recommendation, possibly with an edited value (`changed`).
   * Accepting performs it; approval types need `ctx.approval` (the route checks the factor).
   */
  async accept(id: string, input: { value?: string | undefined }, ctx: ActionContext) {
    const d = this.#pending(id);
    const value = (input.value ?? d.recommendation.value).trim();
    if (!value)
      throw new SindriError(
        "invalid_state",
        "this decision has no recommendation yet; send a value to decide it yourself",
      );
    const values = allowedValues(d.type);
    if (values && !values.includes(value))
      throw new SindriError(
        "validation_failed",
        `value must be one of ${values.join(", ")} for ${d.type}`,
      );
    if (this.#busy.has(id))
      throw new SindriError("invalid_state", "this decision is being applied right now");
    this.#busy.add(id);
    try {
      let result: ApplyResult;
      try {
        result = await this.#apply(d, d.context, value, ctx);
      } catch (err) {
        this.store.record(id, "apply_failed", ctx.actor, { value, error: errorText(err) });
        throw err;
      }
      const changed = value !== d.recommendation.value.trim();
      const updated = this.store.update(
        id,
        {
          status: changed ? "changed" : "accepted",
          finalValue: value,
          applied: result.data,
          reversible: result.reversible,
          error: null,
          decidedAt: this.#iso(),
        },
        { action: changed ? "changed" : "accepted", actor: ctx.actor, detail: { value } },
        { status: "pending" },
      );
      if (!updated) throw new SindriError("invalid_state", "the decision changed meanwhile");
      if (changed) this.#checkCorrections(d.projectId, d.type);
      return StewardStore.view(this.store.get(id)!);
    } finally {
      this.#busy.delete(id);
    }
  }

  reject(id: string, input: { reason?: string | undefined }, actor: string): Decision {
    const d = this.#pending(id);
    if (this.#busy.has(id))
      throw new SindriError("invalid_state", "this decision is being applied right now");
    const updated = this.store.update(
      id,
      { status: "rejected", decidedAt: this.#iso() },
      { action: "rejected", actor, detail: { reason: input.reason ?? null } },
      { status: "pending" },
    );
    if (!updated) throw new SindriError("invalid_state", "the decision changed meanwhile");
    if (input.reason)
      this.store.addNote({
        projectId: d.projectId,
        decisionId: id,
        author: actor,
        text: `Rejected: ${input.reason}`,
      });
    this.#checkCorrections(d.projectId, d.type);
    return StewardStore.view(this.store.get(id)!);
  }

  /** Undoes an applied decision. 409 when it was not applied or cannot be undone. */
  async rollback(id: string, input: { reason: string }, actor: string): Promise<Decision> {
    const d = this.store.get(id);
    if (!d) throw new SindriError("not_found", "decision not found");
    if (!APPLIED.has(d.status) || d.applied === null)
      throw new SindriError("invalid_state", `this decision was not applied (it is ${d.status})`);
    if (!d.reversible)
      throw new SindriError(
        "invalid_state",
        `this ${d.type} decision cannot be rolled back (${d.type === "escalation.resolve" ? "a resolved escalation has already changed the run" : "it changed nothing that can be undone"})`,
      );
    if (this.#busy.has(id))
      throw new SindriError("invalid_state", "this decision is being changed right now");
    this.#busy.add(id);
    try {
      const ctx = { actor };
      if (d.type === "spec.answer") await this.#o.world.revertAnswer(d.applied, ctx);
      else if (d.type === "rework.suggest") await this.#o.world.discardRework(d.applied, ctx);
      else throw new SindriError("invalid_state", `${d.type} decisions cannot be rolled back`);
      const updated = this.store.update(
        id,
        { status: "rolled_back", reversible: false },
        { action: "rolled_back", actor, detail: { reason: input.reason } },
        { status: [...APPLIED] as ("accepted" | "changed" | "applied")[] },
      );
      if (!updated) throw new SindriError("invalid_state", "the decision changed meanwhile");
      this.store.addNote({
        projectId: d.projectId,
        decisionId: id,
        author: actor,
        text: `Rolled back: ${input.reason}`,
      });
      this.#checkCorrections(d.projectId, d.type);
      return StewardStore.view(this.store.get(id)!);
    } finally {
      this.#busy.delete(id);
    }
  }

  noteOnDecision(id: string, text: string, author: string): Decision {
    const d = this.store.get(id);
    if (!d) throw new SindriError("not_found", "decision not found");
    this.store.addNote({ projectId: d.projectId, decisionId: id, author, text });
    return StewardStore.view(this.store.get(id)!);
  }

  addNote(projectId: string | null, text: string, author: string): Note {
    const note = this.store.addNote({ projectId, author, text });
    return note;
  }

  notes(projectId?: string | null): Note[] {
    return this.store.notes(projectId);
  }

  #pending(id: string): StoredDecision {
    const d = this.store.get(id);
    if (!d) throw new SindriError("not_found", "decision not found");
    if (d.status !== "pending")
      throw new SindriError("invalid_state", `this decision is already ${d.status}`);
    return d;
  }

  // ------------------------------------------------------------------ guidance

  guidance(projectId?: string): Guidance[] {
    return this.store.listGuidance(projectId);
  }

  /**
   * The operator accepts or rejects a guidance proposal. Accepting records task evidence of the
   * corrections and a valid knowledge entry citing it, which later recommendations retrieve.
   */
  decideGuidance(
    id: string,
    input: { decision: "accepted" | "rejected"; reason?: string | undefined },
    actor: string,
  ): Guidance {
    const g = this.store.guidance(id);
    if (!g) throw new SindriError("not_found", "guidance proposal not found");
    if (g.status !== "proposed")
      throw new SindriError("invalid_state", `this proposal is already ${g.status}`);
    if (input.decision === "rejected")
      return this.store.decideGuidance(id, {
        status: "rejected",
        by: actor,
        reason: input.reason ?? null,
      })!;
    const k = this.#o.knowledge;
    if (!k) throw new SindriError("invalid_state", "knowledge is not available to the steward");
    return this.#o.db.transaction(() => {
      const evidence = k.evidence.record({
        projectId: g.projectId,
        externalRef: `steward:guidance:${g.id}`,
        kind: "steward.corrections",
        payload: {
          rule: g.rule,
          type: g.type,
          decisions: g.decisionIds.map((did) => {
            const d = this.store.get(did);
            return d
              ? {
                  id: d.id,
                  subject: d.subject.label,
                  recommended: d.recommendation.value,
                  status: d.status,
                  applied: d.appliedValue,
                }
              : { id: did };
          }),
        },
      });
      const entry = k.knowledge.add({
        projectId: g.projectId,
        claim: g.rule,
        sourceRefs: [{ taskEvidenceId: evidence.id }],
        confidence: 0.8,
        createdBy: actor,
      });
      return this.store.decideGuidance(id, {
        status: "accepted",
        by: actor,
        reason: input.reason ?? null,
        entryId: entry.id,
        evidenceId: evidence.id,
      })!;
    })();
  }

  /**
   * After the operator corrected a recommendation: when corrections of this type in this project
   * agree `correctionThreshold` times, proposes the rule they imply (once per rule).
   */
  #checkCorrections(projectId: string, type: DecisionType): void {
    const threshold = this.#o.correctionThreshold ?? 3;
    const corrections = this.store
      .decided(projectId, type, 50)
      // Deciding a subject the steward never recommended on corrects nothing.
      .filter((d) => CORRECTED.has(d.status) && d.recommendation.value.trim() !== "");
    if (corrections.length < threshold) return;
    const groups = new Map<string, StoredDecision[]>();
    const add = (sig: string, d: StoredDecision) =>
      groups.set(sig, [...(groups.get(sig) ?? []), d]);
    const textual = allowedValues(type) === null;
    for (const d of corrections) {
      const rec = norm(type, d.recommendation.value);
      if (d.status === "changed") {
        const fin = norm(type, d.appliedValue ?? "");
        if (rec !== fin) add(`changed:${rec}->${fin}`, d);
      } else add(`rejected:${textual && type === "spec.answer" ? "*" : rec}`, d);
    }
    // Free-text corrections agree when the operator keeps adding the same terms.
    if (textual) {
      const added = corrections
        .filter((d) => d.status === "changed")
        .map((d) => {
          const rec = tokens(d.recommendation.value);
          return { d, terms: [...tokens(d.appliedValue ?? "")].filter((t) => !rec.has(t)) };
        });
      const freq = new Map<string, StoredDecision[]>();
      for (const { d, terms } of added)
        for (const t of terms) freq.set(t, [...(freq.get(t) ?? []), d]);
      const common = [...freq.entries()]
        .filter(([, ds]) => ds.length >= threshold)
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .slice(0, 5);
      if (common.length) {
        // The decisions behind the most frequent term; the signature names every shared term.
        const ids = new Set(common[0]![1].map((d) => d.id));
        groups.set(
          `terms:${common
            .map(([t]) => t)
            .sort()
            .join(",")}`,
          corrections.filter((d) => ids.has(d.id)),
        );
      }
    }
    for (const [sig, ds] of groups) {
      if (ds.length < threshold || this.store.hasGuidance(projectId, type, sig)) continue;
      this.store.proposeGuidance({
        projectId,
        type,
        signature: sig,
        rule: guidanceRule(type, sig, ds, this.store),
        decisionIds: ds.map((d) => d.id),
      });
    }
  }

  // ------------------------------------------------------------------ outcomes

  #recordOutcomes(): void {
    for (const d of this.store.awaitingOutcome()) {
      let o;
      try {
        o = this.#o.world.outcome({
          type: d.type,
          context: d.context,
          appliedValue: d.appliedValue,
          applied: d.applied,
        });
      } catch (err) {
        this.#o.logger?.warn("steward could not read an outcome", {
          decisionId: d.id,
          err: errorText(err),
        });
        continue;
      }
      if (!o || (d.outcome?.result === o.result && d.outcome.detail === o.detail)) continue;
      this.store.update(
        d.id,
        { outcome: o },
        { action: "outcome", actor: STEWARD, detail: o },
        { status: [...APPLIED] as ("accepted" | "changed" | "applied")[] },
      );
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/** Why auto mode leaves a recommendation to the operator, or null when it may apply it. */
function autoRefusal(d: StoredDecision, minConfidence: number): string | null {
  if (APPROVAL_TYPES.has(d.type)) return "approvals are never applied automatically";
  if (d.type === "escalation.resolve" && !AUTO_ESCALATION_DECISIONS.has(d.recommendation.value))
    return `auto mode applies only retry and skip, not ${d.recommendation.value}`;
  if (d.confidence < minConfidence)
    return `confidence ${d.confidence.toFixed(2)} is below ${minConfidence}`;
  return null;
}

/** A heuristic recommendation, its reasoning extended with what the learning inputs show. */
function enrich(h: Heuristic, l: Learning, similar: Learning["past"]): Heuristic {
  const notes: string[] = [];
  const accepted = similar.filter((p) => p.decision.status === "accepted");
  if (accepted.length)
    notes.push(`${accepted.length} similar past recommendation(s) were accepted as they were.`);
  if (l.knowledge.some((k) => k.guidance))
    notes.push("Approved steward guidance for this project applies; check it against this case.");
  const considered = `Considered ${l.notes.length} note(s), ${l.past.length} past decision(s), ${l.knowledge.length} knowledge entr${l.knowledge.length === 1 ? "y" : "ies"} and ${l.lessons.length} Feedback Graph lesson(s).`;
  return {
    ...h,
    confidence: Math.min(0.95, h.confidence + (accepted.length ? 0.1 : 0)),
    reasoning: [h.reasoning, ...notes, considered].join(" "),
  };
}

/** The rule a group of consistent corrections implies, in the operator's terms. */
function guidanceRule(
  type: DecisionType,
  sig: string,
  ds: StoredDecision[],
  store: StewardStore,
): string {
  const examples = ds
    .slice(0, 3)
    .map((d) => `"${clip(d.subject.label, 80)}"`)
    .join("; ");
  const reasons = ds
    .flatMap((d) => store.notesOf(d.id).filter((n) => n.author !== STEWARD))
    .map((n) => clip(n.text, 120))
    .slice(0, 3);
  const why = reasons.length ? ` Operator reasons: ${reasons.join(" | ")}.` : "";
  const [kind, rest = ""] = [sig.slice(0, sig.indexOf(":")), sig.slice(sig.indexOf(":") + 1)];
  if (kind === "changed") {
    const [from, to] = rest.split("->");
    return `Steward guidance (${type}): in this project the operator changed recommendations of "${from}" to "${to}" ${ds.length} times (e.g. ${examples}). Recommend "${to}" in such cases.${why}`;
  }
  if (kind === "rejected")
    return rest === "*"
      ? `Steward guidance (${type}): in this project the operator rejected ${ds.length} recommendations (e.g. ${examples}). Leave such decisions to the operator unless notes or guidance say otherwise.${why}`
      : `Steward guidance (${type}): in this project the operator rejected recommendations of "${rest}" ${ds.length} times (e.g. ${examples}). Do not recommend "${rest}" in such cases without strong evidence.${why}`;
  const terms = rest.split(",").join('", "');
  const finals = ds
    .slice(0, 2)
    .map((d) => `"${clip(d.appliedValue ?? "", 100)}"`)
    .join("; ");
  return `Steward guidance (${type}): in this project the operator's corrections consistently add "${terms}" (${ds.length} times, e.g. ${finals}). Cover these in recommendations.${why}`;
}
