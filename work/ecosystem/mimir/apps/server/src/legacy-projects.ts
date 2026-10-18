import type { EventStore } from "@mimir/core";
import { ProjectSchema } from "@mimir/protocol";
import { emit } from "./emit.js";
import type { ReadModel } from "./readmodel.js";

/**
 * One-time migration of the T6 `server_projects` table: every row whose project has no
 * `project.created` event yet gets one, so projects are event-sourced from here on. The table is
 * left in place (read only) and is no longer written.
 */
export function migrateLegacyProjects(store: EventStore, readModel: ReadModel, now: Date): number {
  const db = store.connection();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_projects'")
    .get();
  if (table === undefined) return 0;
  const rows = db.prepare("SELECT data FROM server_projects ORDER BY created_at, id").all() as {
    data: string;
  }[];
  let migrated = 0;
  for (const row of rows) {
    const parsed = ProjectSchema.safeParse(JSON.parse(row.data));
    if (!parsed.success || readModel.projects.has(parsed.data.id)) continue;
    emit(store, now, {
      type: "project.created",
      streamId: `project:${parsed.data.id}`,
      payload: { project: parsed.data },
      sourceEventId: `legacy-project:${parsed.data.id}`,
    });
    migrated += 1;
  }
  return migrated;
}
