import { z } from "zod";
import { MISSION_TERMINAL_STATUSES } from "@mimir/core";
import {
  CreateCrewRequestSchema,
  ListCrewsQuerySchema,
  MimirError,
  newId,
  type Crew,
  type CrewMember,
  type CreateCrewResponse,
  type ListCrewsResponse,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { emit } from "../emit.js";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { AGENT_ARGV_TEMPLATES } from "../templates.js";
import { byCreated } from "./common.js";
import { budgetFrom, checkBudgetInput } from "./missions.js";

export function crewRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const rm = ctx.readModel;

  for (const action of ["pause", "resume"] as const) {
    app.post(
      `/v1/crews/:id/${action}`,
      idempotent(ctx, `crew.${action}`, (request) => {
        const { id } = parseWith(z.object({ id: z.string().min(1) }), request.params);
        const { expectedVersion } = parseWith(
          z.strictObject({ expectedVersion: z.number().int().nonnegative().optional() }),
          request.body ?? {},
        );
        const crew = rm.crews.get(id);
        if (!crew) throw new MimirError("not_found", "crew not found");
        const mission = rm.missions.get(crew.missionId);
        if (!mission || MISSION_TERMINAL_STATUSES.has(mission.status))
          throw new MimirError("invalid_transition", "mission is terminal");
        if (expectedVersion !== undefined && expectedVersion !== crew.version)
          throw new MimirError("conflict", "crew version changed");
        const paused = action === "pause";
        if (!!crew.schedulingPaused !== paused)
          emit(ctx.store, ctx.now(), {
            type: "crew.scheduling_changed",
            streamId: `crew:${id}`,
            crewId: id,
            missionId: crew.missionId,
            payload: { crewId: crew.id, paused },
          });
        return {
          status: 200,
          body: {
            crew: rm.crews.get(id),
            semantics: "Scheduling only. Existing agent sessions continue.",
          },
          target: id,
        };
      }),
    );
  }
  app.get("/v1/crews", (request): ListCrewsResponse => {
    const q = parseWith(ListCrewsQuerySchema, request.query);
    return {
      crews: [...rm.crews.values()]
        .filter((c) => q.missionId === undefined || c.missionId === q.missionId)
        .sort(byCreated),
    };
  });

  app.post(
    "/v1/crews",
    idempotent(ctx, "crew.create", (request) => {
      const body = parseWith(CreateCrewRequestSchema, request.body);
      const mission = rm.missions.get(body.missionId);
      if (!mission) {
        throw new MimirError("validation_failed", `mission ${body.missionId} not found`, {
          reason: "unknown_mission",
          missionId: body.missionId,
        });
      }
      if (MISSION_TERMINAL_STATUSES.has(mission.status)) {
        throw new MimirError("invalid_transition", `mission is ${mission.status}`, {
          missionId: mission.id,
          status: mission.status,
        });
      }
      body.members.forEach((m, i) => {
        if (AGENT_ARGV_TEMPLATES[m.agentKind] === undefined) {
          throw new MimirError(
            "validation_failed",
            `no argv template for agent kind ${m.agentKind}`,
            {
              issues: [
                {
                  path: ["members", i, "agentKind"],
                  message: "unknown agent kind",
                  code: "custom",
                },
              ],
              known: Object.keys(AGENT_ARGV_TEMPLATES),
            },
          );
        }
      });
      if (body.budget) checkBudgetInput(body.budget, ctx.runtimeReportsUsage);
      const at = ctx.now();
      const iso = at.toISOString();
      const crewId = newId("crw");
      const crew: Crew = {
        id: crewId,
        missionId: mission.id,
        template: body.template,
        status: "configured",
        limits: body.limits ?? {},
        createdAt: iso,
        updatedAt: iso,
        version: 0,
      };
      const members: CrewMember[] = body.members.map((m, i) => ({
        id: newId("cmb"),
        crewId,
        role: m.role,
        agentKind: m.agentKind,
        name: m.name ?? `${m.role}-${i + 1}`,
        createdAt: iso,
        updatedAt: iso,
        version: 0,
      }));
      emit(ctx.store, at, {
        type: "crew.created",
        streamId: `crew:${crewId}`,
        crewId,
        missionId: mission.id,
        payload: {
          crew,
          members,
          ...(body.budget
            ? { budget: budgetFrom(body.budget, { missionId: mission.id, crewId }, iso) }
            : {}),
        },
      });
      const response: CreateCrewResponse = { crew, members };
      return { status: 201, body: response, target: crewId };
    }),
  );
}
