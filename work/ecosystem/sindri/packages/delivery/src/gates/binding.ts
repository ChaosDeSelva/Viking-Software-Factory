import type { SqliteDatabase } from "@sindri/knowledge";
import type { MimirClientFacade } from "@sindri/mimir-client";
import type { DeliveryLoop } from "../delivery-loop.js";
import type {
  ArtifactContentReader,
  ContextReader,
  ExecutionEventView,
  ExecutionReader,
  MimirActions,
  MimirArtifactView,
  PlanView,
} from "./ports.js";

/**
 * Binds the S6 ports to S5's real exports. Every Mimir call goes through `MimirClientFacade`
 * (the only package that imports `@mimir/*`); nothing here uses `facade.sdk`.
 */

/**
 * `ExecutionReader` over S5's `DeliveryLoop` records. S5 stores event payloads but not the
 * envelope's `taskId`/`sessionId`/`source`/`provenance`, so those are recovered from Mimir's
 * event log (`facade.replayEnvelopes`). Rows Sindri wrote itself (no Mimir event id) are not
 * Mimir evidence and are left out. `claimAttempt` increments the same `execution_tasks.attempts`
 * counter DeliveryLoop uses, so retries share one budget.
 */
export function executionReaderFor(deps: {
  db: SqliteDatabase;
  loop: Pick<DeliveryLoop, "get" | "tasks" | "events">;
  mimir: Pick<MimirClientFacade, "replayEnvelopes">;
}): ExecutionReader {
  const plan = (executionId: string): PlanView | undefined => {
    const row = deps.db
      .prepare("SELECT plan_json FROM executions WHERE id = ?")
      .get(executionId) as { plan_json: string } | undefined;
    return row ? (JSON.parse(row.plan_json) as PlanView) : undefined;
  };
  return {
    execution(executionId) {
      const e = deps.loop.get(executionId);
      const p = e && plan(executionId);
      return Promise.resolve(
        e && p
          ? {
              id: e.id,
              planId: e.planId,
              planVersion: e.planVersion,
              mimirMissionId: e.mimirMissionId,
              status: e.status,
              plan: p,
            }
          : undefined,
      );
    },
    tasks(executionId) {
      return Promise.resolve(
        deps.loop.tasks(executionId).map((t) => ({
          planTaskId: t.planTaskId,
          mimirTaskId: t.mimirTaskId,
          mimirSessionId: t.sessionId,
          status: t.status,
          attempts: t.attempts,
        })),
      );
    },
    async events(executionId) {
      const e = deps.loop.get(executionId);
      if (!e) return [];
      const envelopes = await deps.mimir.replayEnvelopes(e.mimirMissionId);
      const refs = new Map(envelopes.map((env) => [env.id as string, env]));
      const out: ExecutionEventView[] = [];
      for (const row of deps.loop.events(executionId)) {
        if (row.mimirEventId === null) continue;
        const env = refs.get(row.mimirEventId);
        out.push({
          mimirEventId: row.mimirEventId,
          type: row.type,
          payload: row.payload,
          occurredAt: row.occurredAt,
          mimirTaskId: env?.taskId ?? null,
          sessionId: env?.sessionId ?? null,
          source: env?.source ?? null,
          provenance: env?.provenance ?? null,
        });
      }
      return out;
    },
    claimAttempt(executionId, planTaskId) {
      const row = deps.db
        .prepare(
          `UPDATE execution_tasks SET attempts = attempts + 1
           WHERE execution_id = ? AND plan_task_id = ? RETURNING attempts`,
        )
        .get(executionId, planTaskId) as { attempts: number } | undefined;
      return row
        ? Promise.resolve(row.attempts)
        : Promise.reject(new Error(`unknown plan task ${planTaskId} in ${executionId}`));
    },
  };
}

/** `MimirActions` over `MimirClientFacade` only. */
export function mimirActionsFor(facade: MimirClientFacade): MimirActions {
  return {
    async getArtifact(artifactId): Promise<MimirArtifactView> {
      const a = await facade.getArtifact(artifactId);
      return { id: a.id, taskId: a.taskId, kind: a.kind, uri: a.uri, hash: a.hash };
    },
    async getMission(missionId) {
      const m = await facade.getMission(missionId);
      return {
        status: m.mission.status,
        crews: m.crews.map((c) => ({ id: c.id, template: c.template })),
        tasks: m.tasks.map((t) => ({
          id: t.id,
          crewId: t.crewId,
          status: t.status,
          title: t.title,
        })),
      };
    },
    async sendInstruction(sessionId, text, idempotencyKey) {
      await facade.sendInstruction(sessionId, text, { idempotencyKey });
    },
    async retry(mimirTaskId, attempt, reason) {
      // Same `sindri:retry:<task>:<attempt>` key DeliveryLoop uses: Mimir dedupes double calls.
      await facade.retry(mimirTaskId, { attempt, reason });
    },
    async createCrew(input, idempotencyKey) {
      return facade.createCrew(input, idempotencyKey);
    },
    async createTask(input, idempotencyKey) {
      const task = await facade.createTask(
        {
          missionId: input.missionId,
          crewId: input.crewId,
          title: input.title,
          brief: input.instruction,
          ...(input.acceptance !== undefined && input.acceptance !== ""
            ? { acceptanceCriteria: [input.acceptance] }
            : {}),
          ...(input.dependsOn ? { dependsOn: input.dependsOn } : {}),
        },
        idempotencyKey,
      );
      return { taskId: task.id };
    },
    requestPr(mimirTaskId, _input, idempotencyKey) {
      // Mimir's route takes no title or body; the description stays in Sindri's delivery report.
      return facade.requestPr(mimirTaskId, idempotencyKey);
    },
  };
}

/** Default bound on one artifact content read (audit L9). */
export const ARTIFACT_READ_TIMEOUT_MS = 30_000;

/**
 * Artifact bytes through Mimir only (`GET /v1/artifacts/:id/content` via the SDK). Fails with
 * `MimirClientError('not_supported')` on an SDK without `artifacts.content`. A read that does
 * not finish within `timeoutMs` is rejected, so a stalled source cannot hang a gate or review
 * (it becomes `artifact_unavailable`).
 */
export function mimirArtifactContentReader(
  facade: Pick<MimirClientFacade, "artifactContent">,
  options: { timeoutMs?: number } = {},
): ArtifactContentReader {
  const timeoutMs = options.timeoutMs ?? ARTIFACT_READ_TIMEOUT_MS;
  return {
    read: (artifact) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`artifact ${artifact.id} read timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      });
      return Promise.race([facade.artifactContent(artifact.id), timeout]).finally(() =>
        clearTimeout(timer),
      );
    },
  };
}

/** The fields of `@sindri/specs` `Specification` the trace and report read. */
interface SpecRecordLike {
  id: string;
  lineageId: string;
  version: number;
  status: string;
  title: string;
  intakeId: string | null;
  body: { acceptanceCriteria: { id: string; text: string; verification: string }[] };
}

/** The fields of `@sindri/intake` `IntakeRecord` the trace reads (never the ticket body). */
interface IntakeRecordLike {
  id: string;
  source: string;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
}

/** `ContextReader` over `openSpecs(db)` and `openIntake(db)` (structurally typed). */
export function contextReaderFrom(stores: {
  specs: { get(id: string): SpecRecordLike | undefined };
  intakes: { get(id: string): IntakeRecordLike | undefined };
}): ContextReader {
  return {
    spec(specId) {
      const s = stores.specs.get(specId);
      return Promise.resolve(
        s && {
          id: s.id,
          lineageId: s.lineageId,
          version: s.version,
          status: s.status,
          title: s.title,
          intakeId: s.intakeId,
          acceptanceCriteria: s.body.acceptanceCriteria.map((a) => ({
            id: a.id,
            text: a.text,
            verification: a.verification,
          })),
        },
      );
    },
    intake(intakeId) {
      const i = stores.intakes.get(intakeId);
      return Promise.resolve(
        i && {
          id: i.id,
          source: i.source,
          externalId: i.externalId,
          externalUrl: i.externalUrl,
          title: i.title,
        },
      );
    },
  };
}
