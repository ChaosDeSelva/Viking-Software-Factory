import {
  UsageQuerySchema,
  type UsageResponse,
  type UsageSample,
  type UsageTotals,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { parseWith } from "../errors.js";
import type { ReadModel } from "../readmodel.js";
import { byCreated } from "./common.js";

/** Sums samples with a per-source breakdown. Null values count as zero (see `uncertain`). */
export function totalsOf(samples: readonly UsageSample[]): UsageTotals {
  const totals: UsageTotals = {
    tokens: 0,
    estimatedCost: 0,
    samples: 0,
    bySource: { measured: 0, estimated: 0, unavailable: 0 },
  };
  for (const s of samples) {
    totals.samples += 1;
    totals.bySource[s.source] += 1;
    totals.tokens += s.tokens ?? 0;
    totals.estimatedCost += s.estimatedCost ?? 0;
  }
  return totals;
}

/** Samples attributed agent → crew → mission → project, filtered by any of those ids. */
export function usageFor(
  rm: ReadModel,
  q: {
    missionId?: string | undefined;
    crewId?: string | undefined;
    projectId?: string | undefined;
    agentId?: string | undefined;
  },
): UsageResponse & { uncertain: boolean } {
  const samples = [...rm.usageSamples.values()]
    .filter((s) => {
      const agent = rm.agents.get(s.agentId);
      const crew = agent ? rm.crews.get(agent.crewId) : undefined;
      const mission = crew ? rm.missions.get(crew.missionId) : undefined;
      if (q.agentId !== undefined && s.agentId !== q.agentId) return false;
      if (q.crewId !== undefined && agent?.crewId !== q.crewId) return false;
      if (q.missionId !== undefined && crew?.missionId !== q.missionId) return false;
      if (q.projectId !== undefined && mission?.projectId !== q.projectId) return false;
      return true;
    })
    .sort(byCreated);
  return {
    totals: totalsOf(samples),
    samples,
    // Totals are a lower bound when any sample lacks a measurement.
    uncertain: samples.some(
      (s) => s.source === "unavailable" || s.tokens === null || s.estimatedCost === null,
    ),
  };
}

export function usageRoutes(app: FastifyInstance): void {
  app.get("/v1/usage", (request) => {
    const q = parseWith(UsageQuerySchema, request.query);
    return usageFor(app.mimir.readModel, q);
  });
}
