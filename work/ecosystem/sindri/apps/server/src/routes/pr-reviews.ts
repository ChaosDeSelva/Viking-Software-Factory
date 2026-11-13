import {
  buildReviewPayload,
  editDraft,
  findMarkedReview,
  leakCheck,
  markerHashOf,
  markReviewPayload,
  PR_REVIEW_VERDICTS,
  PrReviewStore,
  type PrReviewReport,
} from "@sindri/delivery";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import type { DeliveryService } from "../delivery-service.js";
import { DISPLAY_SANITIZED, forDisplay } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { asMimirUnavailable, type ExecutionHub } from "../execution-hub.js";
import type { Factory } from "../factory.js";
import { projectOfExecution } from "../queries.js";
import type { Services } from "../services.js";
import { DELIVERED_STATUSES } from "../statuses.js";

const FindingEditSchema = z.strictObject({
  id: z.string().min(1).max(100),
  included: z.boolean(),
  message: z.string().trim().min(1).max(2000).optional(),
  suggestion: z.string().max(4000).nullable().optional(),
});

const EditReview = z.strictObject({
  verdict: z.enum(PR_REVIEW_VERDICTS).optional(),
  summary: z.string().trim().max(8000).optional(),
  findings: z.array(FindingEditSchema).max(400).optional(),
});

/**
 * PR review deliveries: the operator edits a draft over the agent's review (bearer token), previews
 * exactly what would be posted, and posts it to GitHub through `gh` (approval secret). Nothing
 * reaches GitHub before that approval.
 */
export function prReviewRoutes(
  app: FastifyInstance,
  s: Services,
  hub: ExecutionHub,
  delivery: DeliveryService,
  approvals: ApprovalAuthority,
  f: Factory,
) {
  const store = new PrReviewStore(s.db);
  /** Executions whose review is being posted right now, in this process. */
  const posting = new Set<string>();

  /** A delivered PR review execution and its report's review part. */
  const requireReview = async (id: string) => {
    const execution = hub.reader.get(id);
    if (!execution) throw notFound("execution");
    if ((f.planner.get(execution.planId)?.work?.kind ?? "change") !== "pr_review")
      throw new ApiError(409, "invalid_state", "this execution is not a PR review");
    if (!DELIVERED_STATUSES.has(execution.status))
      throw new ApiError(
        409,
        "invalid_state",
        `execution is ${execution.status}; the review exists once it is verified`,
      );
    let report;
    try {
      report = await delivery.report(id);
    } catch (err) {
      throw asMimirUnavailable(err);
    }
    if (!report.review) throw new ApiError(409, "invalid_state", "the report holds no review");
    const projectId = projectOfExecution(s.db, id) ?? report.projectId;
    return { execution, review: report.review as Required<PrReviewReport>, projectId };
  };

  /** Why posting is refused right now (empty when it may go ahead), and the payload. */
  const prepare = (executionId: string, review: Required<PrReviewReport>) => {
    const draft = review.draft;
    const built = buildReviewPayload(draft, review.pr.headSha);
    // The leak check reads what the reviewers and operator wrote; the marker is ours.
    const leak = leakCheck(built.texts);
    const { payload, payloadSha256 } = markReviewPayload(built.payload, executionId);
    const gates = delivery.gateResults(executionId);
    const gatesPassed = gates.length > 0 && gates.every((g) => g.passed) && review.gatePassed;
    return { draft, payload, payloadSha256, leak, gatesPassed };
  };

  app.get<{ Params: { id: string } }>("/v1/executions/:id/review", async (req) => {
    const { review } = await requireReview(req.params.id);
    return { review };
  });

  // Editing needs the bearer token only: a draft changes nothing outside Sindri.
  app.put<{ Params: { id: string } }>("/v1/executions/:id/review", async (req) => {
    const body = parseBody(EditReview, req.body);
    const { execution, review, projectId } = await requireReview(req.params.id);
    // The draft being posted must not change under the post (it holds this lock throughout).
    if (posting.has(execution.id))
      throw new ApiError(409, "post_in_progress", "this review is being posted right now");
    const posted = store.posted(execution.id);
    if (posted)
      throw new ApiError(409, "already_posted", "this review was already posted", {
        htmlUrl: posted.htmlUrl,
      });
    const edit = editDraft(review.draft, body);
    if (!edit.ok)
      throw new ApiError(422, "validation_failed", "unknown finding ids", {
        unknown: edit.unknown,
      });
    store.saveDraft(execution.id, projectId, edit.next, "operator");
    return { review: (await requireReview(execution.id)).review };
  });

  // The payload is returned byte for byte (it is what GitHub would receive); render it as text.
  app.get<{ Params: { id: string } }>(
    "/v1/executions/:id/review/preview",
    { config: { [DISPLAY_SANITIZED]: true } },
    async (req) => {
      const { execution, review } = await requireReview(req.params.id);
      const { draft, payload, leak, gatesPassed } = prepare(execution.id, review);
      const posted = store.posted(execution.id);
      const blockers = [
        ...(gatesPassed ? [] : ["gates_not_passed"]),
        ...(leak.ok ? [] : ["post_blocked"]),
        ...(posted ? ["already_posted"] : []),
      ];
      return {
        ...forDisplay({
          draftVersion: draft.version,
          pr: review.pr,
          leakCheck: leak,
          gatesPassed,
          posted,
          canPost: blockers.length === 0,
          blockers,
        }),
        payload,
      };
    },
  );

  app.post<{ Params: { id: string } }>("/v1/executions/:id/review/post", async (req) => {
    // Posting to GitHub is a human approval: the approval secret, not just the token.
    const actor = approvals.require(req);
    const { execution, review, projectId } = await requireReview(req.params.id);
    const earlier = store.posted(execution.id);
    if (earlier)
      throw new ApiError(409, "already_posted", "this review was already posted", {
        htmlUrl: earlier.htmlUrl,
        reviewId: earlier.reviewId,
      });
    if (posting.has(execution.id))
      throw new ApiError(409, "post_in_progress", "this review is being posted right now");
    posting.add(execution.id);
    try {
      const { draft, payload, payloadSha256, leak, gatesPassed } = prepare(execution.id, review);
      if (!gatesPassed)
        throw new ApiError(409, "gates_not_passed", "the review's quality gates have not passed");
      if (!leak.ok)
        throw new ApiError(
          422,
          "post_blocked",
          `the review holds text that must stay local (${leak.rule})`,
          leak,
        );
      if (s.settings.get().localOnly)
        throw new ApiError(503, "local_only", "local-only mode is on: posting to GitHub is off");
      const pr = review.pr;
      const ref = { owner: pr.owner, repo: pr.repo, number: pr.number };
      const record = (
        created: { id: number; htmlUrl: string },
        how: string,
        from: { draftVersion: number | null; payloadSha256: string; recovered?: boolean } = {
          draftVersion: draft.version,
          payloadSha256,
        },
      ) => {
        const posted = store.recordPost(projectId, {
          executionId: execution.id,
          draftVersion: from.draftVersion,
          reviewId: created.id,
          htmlUrl: created.htmlUrl,
          commitId: pr.headSha,
          payloadSha256: from.payloadSha256,
          actor,
          ...(from.recovered ? { recovered: true } : {}),
        });
        req.log.info({ executionId: execution.id, reviewId: created.id, actor }, how);
        return posted;
      };
      /**
       * A review found by its marker is recorded with the attempt that sent it (matched by the
       * marker's payload hash), which may be an earlier draft version than the current one.
       */
      const recordFound = (found: { id: number; htmlUrl: string; body: string }, how: string) => {
        const hash = markerHashOf(found.body, execution.id) ?? "";
        const attempt = store.attemptByHash(execution.id, hash);
        return record(
          found,
          how,
          attempt
            ? { draftVersion: attempt.draftVersion, payloadSha256: attempt.payloadSha256 }
            : { draftVersion: null, payloadSha256: hash, recovered: true },
        );
      };
      /** A review of this execution GitHub already holds (an earlier post that timed out). */
      const existing = async () =>
        findMarkedReview(await s.gh.listReviews(ref), execution.id) ?? null;
      let earlierPost;
      try {
        earlierPost = await existing();
      } catch {
        throw new ApiError(
          502,
          "github_error",
          "listing the PR's reviews failed; nothing was posted",
        );
      }
      if (earlierPost)
        return {
          posted: recordFound(earlierPost, "PR review found on GitHub and recorded"),
          review: (await requireReview(execution.id)).review,
        };
      let current: unknown;
      try {
        current = await s.gh.prView(pr.url);
      } catch {
        throw new ApiError(502, "github_error", "gh pr view failed; check gh auth status");
      }
      const head = (current as { headRefOid?: unknown } | null)?.headRefOid;
      if (head !== pr.headSha)
        throw new ApiError(
          409,
          "pr_head_moved",
          "the pull request has new commits since this review; re-import it and run the review again",
          { reviewedSha: pr.headSha, currentSha: typeof head === "string" ? head : null },
        );
      store.recordAttempt(execution.id, projectId, { draftVersion: draft.version, payloadSha256 });
      let created;
      try {
        created = await s.gh.postReview(ref, payload);
      } catch {
        // A timeout can leave the review created on GitHub: look for its marker before failing.
        const found = await existing().catch(() => null);
        if (!found)
          throw new ApiError(
            502,
            "github_error",
            "posting the review failed and GitHub holds no review from it; try again",
          );
        return {
          posted: recordFound(found, "PR review found on GitHub after a failed post"),
          review: (await requireReview(execution.id)).review,
        };
      }
      const posted = record(created, "PR review posted to GitHub");
      return { posted, review: (await requireReview(execution.id)).review };
    } finally {
      posting.delete(execution.id);
    }
  });

  /** Whether GitHub pull requests can be imported: settings and a lazily detected `gh`. */
  app.get("/v1/github/status", async () => {
    const setting = s.settings.get().connectors?.github?.enabled;
    const ghInstalled = await s.gh.available();
    return {
      enabled: setting ?? ghInstalled,
      configured: setting !== undefined,
      ghInstalled,
      localOnly: s.settings.get().localOnly,
    };
  });
}
