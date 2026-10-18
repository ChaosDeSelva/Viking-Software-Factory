import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openEventStore, redactPayload } from "@mimir/core";
import { CliError, EXIT_CONFIG, EXIT_INFRA, dataDir, dbPath } from "./env.js";

export function exportMission(
  missionId: string,
  out: string,
  options: { force?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): { missionId: string; out: string; count: number } {
  const db = dbPath(dataDir(env));
  if (!existsSync(db)) throw new CliError(`no event store at ${db}`, EXIT_INFRA);
  if (existsSync(out) && !options.force) {
    throw new CliError(`${out} already exists; pass --force to overwrite`, EXIT_CONFIG);
  }
  try {
    // Read-only: never takes the writer lock, so a running server is not disturbed.
    const store = openEventStore(db, { readOnly: true });
    try {
      const events = [];
      let cursor: string | undefined;
      for (;;) {
        const page = store.read({ limit: 500, missionId, ...(cursor ? { cursor } : {}) });
        events.push(...page.events.map((e) => ({ ...e, payload: redactPayload(e.payload) })));
        // Stop on every end signal; also guard against an empty page or a cursor that does not advance.
        if (
          page.nextCursor === null ||
          !page.hasMore ||
          page.events.length === 0 ||
          page.nextCursor === cursor
        )
          break;
        cursor = page.nextCursor;
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify({ missionId, exportedAt: new Date().toISOString(), events }, null, 2) + "\n",
        { mode: 0o600, flag: options.force ? "w" : "wx" },
      );
      return { missionId, out, count: events.length };
    } finally {
      store.close();
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`export failed: ${(e as Error).message}`, EXIT_INFRA);
  }
}
