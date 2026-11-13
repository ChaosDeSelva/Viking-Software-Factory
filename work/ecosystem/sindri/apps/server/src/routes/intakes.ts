import {
  MAX_FIELD_CHARS,
  MAX_REQUEST_SKILLS,
  parsePullRequestUrl,
  pullRequestOfSnapshot,
  WORK_KINDS,
  type IntakeCommentRecord,
  type IntakeRecord,
} from "@sindri/intake";
import { MAX_REQUEST_NOTES_BYTES, openGuidance, utf8Capped } from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DISPLAY_SANITIZED, forDisplay } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { cachedRemoteLookup } from "../review-mirror.js";
import type { Services } from "../services.js";

/**
 * API view of an intake: raw remote payloads stay server-side. Ticket text goes out only as the
 * display copy the intake stored when it was written (audit M5: sanitized once, never per
 * response); short metadata strings are sanitized here.
 */
/** The PR facts of a GitHub intake (never its body), or null. */
function pullRequestView(r: IntakeRecord) {
  if (r.source !== "github") return null;
  const pr = pullRequestOfSnapshot(r.snapshot.raw);
  if (!pr) return null;
  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    author: pr.author,
    state: pr.state,
    baseRef: pr.baseRefName,
    baseSha: pr.baseRefOid,
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    isCrossRepository: pr.isCrossRepository,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.files.length,
  };
}

export function intakeView(r: IntakeRecord) {
  return {
    ...forDisplay({
      id: r.id,
      projectId: r.projectId,
      source: r.source,
      externalId: r.externalId,
      externalUrl: r.externalUrl,
      status: r.snapshot.status ?? null,
      importedAt: r.importedAt,
      syncState: r.syncState,
      permissions: r.permissions,
      createdAt: r.createdAt,
      workKind: r.workKind,
      notes: r.notes,
      skillIds: r.skillIds,
      research: r.research,
      linkedExecutionId: r.linkedExecutionId,
      pullRequest: pullRequestView(r),
    }),
    title: r.display.title,
    body: r.display.body,
    hasPendingSnapshot: r.pendingSnapshot !== null,
    display: r.display,
  };
}

const commentView = (c: IntakeCommentRecord) => ({
  ...forDisplay({
    id: c.id,
    intakeId: c.intakeId,
    createdAt: c.createdAt,
    externalId: c.externalId,
    origin: c.origin,
  }),
  author: c.display.author,
  body: c.display.body,
  display: c.display,
});

/** These routes return only stored display text; the global response sanitizer skips them. */
const sanitized = { config: { [DISPLAY_SANITIZED]: true } };

/** Work kind and operator guidance a new intake may carry. */
const WorkFields = {
  workKind: z.enum(WORK_KINDS).optional(),
  notes: utf8Capped(MAX_REQUEST_NOTES_BYTES, "notes").optional(),
  skillIds: z.array(z.string().min(1).max(100)).max(MAX_REQUEST_SKILLS).optional(),
  research: z
    .strictObject({
      sources: z
        .strictObject({
          code: z.boolean().optional(),
          feedbackGraph: z.boolean().optional(),
          web: z.boolean().optional(),
        })
        .optional(),
      factCheck: z.boolean().optional(),
    })
    .optional(),
};

const ManualIntake = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  // Same cap as connector imports (review m6).
  body: z.string().max(MAX_FIELD_CHARS),
  ...WorkFields,
});

const ImportIntake = z.strictObject({
  // Optional for a GitHub pull request: the project whose remote is that repository is used.
  projectId: z.string().min(1).optional(),
  url: z.string().url().max(2048),
  ...WorkFields,
});

/** 422 `local_only` for a research request that asks for the web while local-only mode is on. */
export function refuseLocalOnlyWeb(
  s: Pick<Services, "settings">,
  work: {
    workKind?: string | undefined;
    research?: { sources?: { web?: boolean | undefined } | undefined } | undefined;
  },
) {
  if (work.workKind === "research" && work.research?.sources?.web && s.settings.get().localOnly)
    throw new ApiError(
      422,
      "local_only",
      "local-only mode is on: web research is unavailable; untick the Web source or turn off local-only mode in Settings",
    );
}

export function intakeRoutes(app: FastifyInstance, s: Services) {
  const requireProject = (id: string) => {
    if (!s.knowledge.projects.get(id)) throw notFound("project");
  };
  const guidance = openGuidance(s.db);
  const requireSkills = (ids: readonly string[] = []) => {
    const unknown = guidance.unknownSkills(ids);
    if (unknown.length > 0)
      throw new ApiError(422, "validation_failed", "unknown skill ids", { unknown });
  };

  /**
   * The project of a GitHub pull request URL: the one registered project whose git remotes
   * include that repository. Otherwise the request must name the project (422 `project_required`
   * with the candidates).
   */
  const remotesOf = cachedRemoteLookup();
  const projectForPullRequest = async (url: string): Promise<string> => {
    const pr = parsePullRequestUrl(url);
    if (pr && s.settings.get().connectors?.github?.enabled === false)
      throw new ApiError(422, "no_connector", "GitHub pull requests are turned off in settings");
    const projects = s.knowledge.projects.list();
    const all = projects.map((p) => ({ id: p.id, name: p.name }));
    if (!pr) throw new ApiError(422, "validation_failed", "projectId is required");
    const repo = `${pr.owner}/${pr.repo}`.toLowerCase();
    const remotes = await remotesOf(projects);
    const matches = projects.filter((p) => remotes.get(p.id)?.includes(repo));
    if (matches.length === 1) return matches[0]!.id;
    throw new ApiError(
      422,
      "project_required",
      matches.length === 0
        ? `no registered project has ${repo} as a git remote; choose the project`
        : `several projects have ${repo} as a git remote; choose one`,
      {
        repo,
        candidates: matches.length > 0 ? matches.map((p) => ({ id: p.id, name: p.name })) : all,
      },
    );
  };

  app.post("/v1/intakes", sanitized, (req, reply) => {
    const body = parseBody(ManualIntake, req.body);
    refuseLocalOnlyWeb(s, body);
    requireProject(body.projectId);
    requireSkills(body.skillIds);
    const rec = s.intake().createManual(body);
    return reply.code(201).send({ intake: intakeView(rec) });
  });

  app.post("/v1/intakes/import", sanitized, async (req, reply) => {
    const body = parseBody(ImportIntake, req.body);
    refuseLocalOnlyWeb(s, body);
    if (s.settings.get().localOnly)
      throw new ApiError(503, "local_only", "local-only mode is on: ticket imports are disabled");
    if (body.projectId) requireProject(body.projectId);
    requireSkills(body.skillIds);
    const { url, projectId: given, ...work } = body;
    const projectId = given ?? (await projectForPullRequest(url));
    // 200 when the ticket was already imported: the existing intake comes back.
    const { intake: rec, created } = await s.intake().importUrl(url, { ...work, projectId });
    return reply.code(created ? 201 : 200).send({ intake: intakeView(rec) });
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/intakes", sanitized, (req) => {
    const q = parseBody(z.object({ projectId: z.string().min(1) }), req.query);
    requireProject(q.projectId);
    return { intakes: s.intake().list(q.projectId).map(intakeView) };
  });

  app.get<{ Params: { id: string } }>("/v1/intakes/:id", sanitized, (req) => {
    const intake = s.intake();
    const rec = intake.get(req.params.id);
    if (!rec) throw notFound("intake");
    return { intake: intakeView(rec), comments: intake.comments(rec.id).map(commentView) };
  });
}
