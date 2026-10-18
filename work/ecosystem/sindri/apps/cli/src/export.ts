import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { strToU8, zipSync } from "fflate";
import { CliError, EXIT_CONFIG, EXIT_INFRA, dataDir, dbPath } from "./env.js";

/** Same layout as GET /v1/export: sindri.db snapshot, settings.json (handles only), manifest.json. */
export function exportData(
  out: string,
  options: { force?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): { out: string; bytes: number } {
  const dbFile = dbPath(dataDir(env));
  if (!existsSync(dbFile)) throw new CliError(`no database at ${dbFile}`, EXIT_INFRA);
  if (existsSync(out) && !options.force) {
    throw new CliError(`${out} already exists; pass --force to overwrite`, EXIT_CONFIG);
  }
  const tmp = mkdtempSync(join(tmpdir(), "sindri-export-"));
  try {
    const db = openDatabase(dbFile);
    try {
      const snapshot = join(tmp, "sindri.db");
      db.prepare("VACUUM INTO ?").run(snapshot);
      const row = db.prepare("SELECT settings_json FROM server_settings WHERE id = 1").get() as
        { settings_json: string } | undefined;
      const zip = zipSync({
        "sindri.db": new Uint8Array(readFileSync(snapshot)),
        "settings.json": strToU8(JSON.stringify(row ? JSON.parse(row.settings_json) : {}, null, 2)),
        "manifest.json": strToU8(
          JSON.stringify(
            { format: "sindri-export/1", exportedAt: new Date().toISOString() },
            null,
            2,
          ),
        ),
      });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, zip, { mode: 0o600 });
      return { out, bytes: zip.length };
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`export failed: ${(e as Error).message}`, EXIT_INFRA);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
