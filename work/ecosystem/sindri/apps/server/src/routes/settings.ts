import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { receiptKey } from "../idempotency.js";
import { REDACTED_RECEIPT } from "./approvals.js";
import { deliveryPurgeTargets, purgeDeliveryData } from "../delivery-purge.js";
import type { Services } from "../services.js";
import { localOnlyViolation, SettingsSchema } from "../settings.js";

export interface SettingsRouteOptions {
  dataDir?: string;
  version: string;
  /** Before a project purge (stop background work on its executions). */
  beforePurge?: (projectId: string) => Promise<void>;
  /** Erasing immutable task evidence is an approval (review I1). */
  approvals: ApprovalAuthority;
  /** After settings are saved (re-attach Mimir runs, review m2). */
  afterChange?: () => Promise<void>;
}

const DeleteBody = z.object({
  confirm: z.string().optional(),
  /** Tombstone the project's immutable task evidence instead of refusing (audit M4). */
  eraseEvidence: z.boolean().optional(),
});

export function settingsRoutes(app: FastifyInstance, s: Services, o: SettingsRouteOptions) {
  const tokenLocation = o.dataDir ? join(o.dataDir, "auth-token") : null;

  app.get("/v1/settings", () => ({ settings: s.settings.get(), tokenLocation }));

  app.put("/v1/settings", async (req) => {
    const settings = parseBody(SettingsSchema, req.body);
    const violation = localOnlyViolation(settings);
    if (violation) throw new ApiError(422, "local_only", violation);
    const saved = s.settings.put(settings);
    void Promise.resolve()
      .then(() => o.afterChange?.())
      .catch((err: unknown) => {
        req.log.error({ err }, "Settings saved; Mimir reconnection failed");
      });
    return { settings: saved };
  });

  app.get("/v1/export", (_req, reply) => {
    const tmp = mkdtempSync(join(tmpdir(), "sindri-export-"));
    try {
      const snapshot = join(tmp, "sindri.db");
      // A consistent, compacted copy of the live (WAL) database.
      s.db.prepare("VACUUM INTO ?").run(snapshot);
      const exportedAt = new Date().toISOString();
      const zip = zipSync({
        "sindri.db": new Uint8Array(readFileSync(snapshot)),
        // Settings hold SecretStore handle names only; secret values never leave the store.
        "settings.json": strToU8(JSON.stringify(s.settings.get(), null, 2)),
        "manifest.json": strToU8(
          JSON.stringify(
            { format: "sindri-export/1", serverVersion: o.version, exportedAt },
            null,
            2,
          ),
        ),
      });
      const stamp = exportedAt.replace(/[:.]/g, "-");
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="sindri-export-${stamp}.zip"`)
        .send(Buffer.from(zip));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/projects/:id/data",
    // Its own idempotency record must not name the purged project (review I3).
    { config: { [REDACTED_RECEIPT]: true } },
    async (req) => {
      const project = s.knowledge.projects.get(req.params.id);
      if (!project) throw notFound("project");
      const body = parseBody(DeleteBody, req.body);
      // Erasing the immutable evidence trail needs the human approval factor (review I1).
      const eraser = body.eraseEvidence === true ? o.approvals.require(req) : null;
      if (body.confirm !== project.name)
        throw new ApiError(
          422,
          "confirmation_required",
          "set `confirm` to the exact project name to delete its data",
        );
      // Blob paths must be read before the rows that reference them are gone.
      const intake = s.intake();
      const blobs = intake.attachmentPaths(project.id);
      const raw = req.headers["idempotency-key"];
      const rawKey = (Array.isArray(raw) ? raw[0] : raw) ?? null;
      const ownKey = rawKey === null ? null : receiptKey(rawKey);
      // Refuse before touching anything (the purge would refuse too): a refused purge must not
      // stop the project's runs (review m5).
      const evidence = (
        s.db
          .prepare("SELECT count(*) AS n FROM task_evidence WHERE project_id = ?")
          .get(project.id) as {
          n: number;
        }
      ).n;
      if (evidence > 0 && body.eraseEvidence !== true)
        throw new ApiError(
          409,
          "invalid_state",
          "the project has immutable task evidence; send eraseEvidence: true to erase it (id and hash are kept)",
        );
      await o.beforePurge?.(project.id);
      s.db.transaction(() => {
        // Delivery rows have no FK to projects: delete them while the plans still exist.
        purgeDeliveryData(s.db, project.id, deliveryPurgeTargets(s.db, project.id), ownKey);
        // Cascades through every package table; refused (409) while task evidence exists.
        s.knowledge.projects.purge(project.id, { eraseEvidence: body.eraseEvidence === true });
        s.commands.purgeProject(project.id, ownKey);
      })();
      // Move the zeroed pages out of the WAL so purged text does not linger on disk.
      s.db.pragma("wal_checkpoint(TRUNCATE)");
      intake.deleteUnreferencedBlobs(blobs);
      if (eraser) req.log.info({ evidenceErased: evidence, eraser }, "task evidence erased");
      return {
        deleted: {
          projectId: project.id,
          ...(body.eraseEvidence === true ? { evidenceErased: evidence } : {}),
        },
      };
    },
  );
}
