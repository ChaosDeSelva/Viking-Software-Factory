import { recordRun } from "@sindri/director";
import {
  APPROVAL_TYPES,
  DECISION_STATUSES,
  DECISION_TYPES,
  MODES,
  Steward,
  type LessonSource,
} from "@sindri/steward";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APPROVAL_HEADER, type ApprovalAuthority } from "../approval.js";
import { notFound, parseBody } from "../errors.js";
import type { Factory } from "../factory.js";
import type { HubNotice } from "../execution-hub.js";
import type { Services } from "../services.js";
import { ServerStewardWorld } from "../steward-world.js";

/** Steward loop options (`BuildServerOptions.steward`). */
export interface StewardServerOptions {
  /**
   * Start the loop when the server is ready. Default: on, except when `resumeOnReady` is false
   * (`sindri demo`) or the server was given a fixed provider or director (tests, e2e), whose
   * scripted answers the loop would otherwise consume.
   */
  autoStart?: boolean;
  /** Periodic catch-up tick. Default 30 s. */
  tickMs?: number;
  /** Delay between an event and its tick. Default 250 ms. */
  nudgeMs?: number;
  /** Auto mode applies recommendations at least this confident. Default 0.6. */
  autoMinConfidence?: number;
}

const Type = z.enum(DECISION_TYPES);
const Modes = z.strictObject({ type: Type, mode: z.enum(MODES) });
const ListQuery = z.object({
  projectId: z.string().min(1).max(200).optional(),
  type: Type.optional(),
  status: z.enum(DECISION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.string().min(1).max(200).optional(),
});
const Accept = z.strictObject({ value: z.string().trim().min(1).max(20_000).optional() });
const Reject = z.strictObject({ reason: z.string().trim().min(1).max(2000).optional() });
const Rollback = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
const NoteBody = z.strictObject({ text: z.string().trim().min(1).max(10_000) });
const NewNote = z.strictObject({
  projectId: z.string().min(1).max(200).nullable(),
  text: z.string().trim().min(1).max(10_000),
});
const NotesQuery = z.object({ projectId: z.string().min(1).max(200).optional() });
const GuidanceDecision = z.strictObject({
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(1).max(2000).optional(),
});

/** Feedback Graph status when its route is missing or fails. */
const FG_UNKNOWN = { configured: false, enabled: false, url: null, reachable: null, error: null };

/** Paths whose successful mutations may create something to recommend on. */
const NUDGE_PATHS = /^\/v1\/(director|specs|plans|executions|deliveries)\b/;
const NUDGE_NOTICES = new Set<HubNotice["type"]>([
  "escalated",
  "status_changed",
  "inbox_item",
  "replan_requested",
  "quality_assessed",
]);

const stewards = new WeakMap<FastifyInstance, Steward>();

/** The steward of a built server (tests drive its ticks). */
export function stewardOf(app: FastifyInstance): Steward | undefined {
  return stewards.get(app);
}

type IdParams = { Params: { id: string } };

/**
 * The steward: its loop (started on ready, fed by execution notices and by successful spec,
 * plan, execution and delivery requests, plus a periodic catch-up tick) and its routes.
 */
export function stewardRoutes(
  app: FastifyInstance,
  s: Services,
  f: Factory,
  approvals: ApprovalAuthority,
  o: StewardServerOptions & {
    authToken: string;
    now: () => Date;
    resumeOnReady?: boolean;
    fixedProvider?: boolean;
  },
): Steward {
  // Structural: the steward package does not depend on @sindri/feedback-graph.
  const lessons: LessonSource = s.feedbackGraph;
  const steward = new Steward({
    db: s.db,
    world: new ServerStewardWorld({
      app,
      services: s,
      factory: f,
      authToken: o.authToken,
      now: o.now,
    }),
    provider: () => f.provider(),
    lessons,
    knowledge: s.knowledge,
    now: o.now,
    ...(o.tickMs !== undefined ? { tickMs: o.tickMs } : {}),
    ...(o.nudgeMs !== undefined ? { nudgeMs: o.nudgeMs } : {}),
    ...(o.autoMinConfidence !== undefined ? { autoMinConfidence: o.autoMinConfidence } : {}),
    logger: { warn: (msg, fields) => app.log.warn(fields ?? {}, msg) },
    onProviderRun: (run) => {
      // Cost accounting beside the Director's runs; a call that measured nothing is not a run.
      if (run.outcome !== undefined && run.usage === null) return;
      try {
        recordRun(s.db, run, o.now().toISOString());
      } catch {
        /* the director tables are not there yet */
      }
    },
  });
  stewards.set(app, steward);

  const unsubscribe = f.hub.subscribe((n) => {
    if (NUDGE_NOTICES.has(n.type)) steward.nudge();
  });
  app.addHook("onResponse", async (req, reply) => {
    const path = req.routeOptions.url ?? req.url;
    if (req.method !== "GET" && reply.statusCode < 400 && NUDGE_PATHS.test(path)) steward.nudge();
  });
  app.addHook("onReady", async () => {
    if (o.autoStart ?? (o.resumeOnReady !== false && o.fixedProvider !== true)) steward.start();
  });
  app.addHook("preClose", async () => {
    unsubscribe();
    await steward.close();
  });

  const feedbackGraphStatus = async (): Promise<unknown> => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/feedback-graph/status",
        headers: { host: "127.0.0.1", authorization: `Bearer ${o.authToken}` },
      });
      return res.statusCode === 200 ? res.json() : FG_UNKNOWN;
    } catch {
      return FG_UNKNOWN;
    }
  };
  const status = async () => ({ ...steward.status(), feedbackGraph: await feedbackGraphStatus() });

  app.get("/v1/steward/status", () => status());

  app.put("/v1/steward/modes", (req) => {
    const by = approvals.require(req);
    const body = parseBody(Modes, req.body);
    return { types: steward.setMode(body.type, body.mode, by) };
  });

  app.post("/v1/steward/pause", () => {
    steward.pause("user");
    return status();
  });
  app.post("/v1/steward/resume", () => {
    steward.resume("user");
    return status();
  });

  app.get("/v1/steward/decisions", (req) => {
    const q = parseBody(ListQuery, req.query);
    if (q.projectId && !s.knowledge.projects.get(q.projectId)) throw notFound("project");
    return {
      decisions: steward.list({
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.before ? { before: q.before } : {}),
      }),
    };
  });

  app.get<IdParams>("/v1/steward/decisions/:id", (req) => ({
    decision: steward.get(req.params.id),
  }));

  app.post<IdParams>("/v1/steward/decisions/:id/accept", async (req) => {
    const d = steward.get(req.params.id);
    const body = parseBody(Accept, req.body);
    // Accepting an approval recommendation performs the approval: the human factor applies.
    if (APPROVAL_TYPES.has(d.type)) {
      const principal = approvals.require(req);
      const raw = req.headers[APPROVAL_HEADER];
      const secret = (Array.isArray(raw) ? raw[0] : raw) as string;
      return {
        decision: await steward.accept(
          d.id,
          { value: body.value },
          { actor: principal, approval: secret },
        ),
      };
    }
    return {
      decision: await steward.accept(d.id, { value: body.value }, { actor: "user" }),
    };
  });

  app.post<IdParams>("/v1/steward/decisions/:id/reject", (req) => {
    const body = parseBody(Reject, req.body);
    return { decision: steward.reject(req.params.id, { reason: body.reason }, "user") };
  });

  app.post<IdParams>("/v1/steward/decisions/:id/rollback", async (req) => {
    const body = parseBody(Rollback, req.body);
    return { decision: await steward.rollback(req.params.id, { reason: body.reason }, "user") };
  });

  app.post<IdParams>("/v1/steward/decisions/:id/notes", (req) => {
    const body = parseBody(NoteBody, req.body);
    return { decision: steward.noteOnDecision(req.params.id, body.text, "user") };
  });

  app.get("/v1/steward/notes", (req) => {
    const q = parseBody(NotesQuery, req.query);
    if (q.projectId && !s.knowledge.projects.get(q.projectId)) throw notFound("project");
    return { notes: steward.notes(q.projectId) };
  });

  app.post("/v1/steward/notes", (req, reply) => {
    const body = parseBody(NewNote, req.body);
    if (body.projectId !== null && !s.knowledge.projects.get(body.projectId))
      throw notFound("project");
    return reply.code(201).send({ note: steward.addNote(body.projectId, body.text, "user") });
  });

  // Additive to the contract: guidance proposed from repeated corrections, decided by a human.
  app.get("/v1/steward/guidance", (req) => {
    const q = parseBody(NotesQuery, req.query);
    if (q.projectId && !s.knowledge.projects.get(q.projectId)) throw notFound("project");
    return { guidance: steward.guidance(q.projectId) };
  });

  app.post<IdParams>("/v1/steward/guidance/:id/decision", (req) => {
    const by = approvals.require(req);
    const body = parseBody(GuidanceDecision, req.body);
    return {
      guidance: steward.decideGuidance(
        req.params.id,
        { decision: body.decision, reason: body.reason },
        by,
      ),
    };
  });

  return steward;
}
