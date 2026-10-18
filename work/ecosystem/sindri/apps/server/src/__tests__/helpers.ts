import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildServer, type BuildServerOptions } from "../app.js";

export const TOKEN = "t".repeat(64);
export const ORIGIN = "http://127.0.0.1:5173";
/** The fixed approval pairing code of test servers (production generates one per start). */
export const PAIRING_CODE = "TESTC-0DE23";

export interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
  dir: string;
  /** An empty directory usable as a project repoPath (the data dir itself is refused). */
  repoDir: string;
  logs: string[];
  /** Authenticated request; mutating methods get a fresh Idempotency-Key unless given. */
  call(opts: InjectOptions & { key?: string | null }): Promise<LightMyRequestResponse>;
  /** Headers carrying an approval secret (minted once per harness with the pairing code). */
  approvalHeaders(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

let counter = 0;

export async function makeHarness(opts: Partial<BuildServerOptions> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "sindri-server-"));
  const dbPath = join(dir, "sindri.db");
  const repoDir = mkdtempSync(join(tmpdir(), "sindri-repo-"));
  const db = openDatabase(dbPath);
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const app = await buildServer({
    db,
    dbPath,
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
    authToken: TOKEN,
    logStream,
    approval: { pairingCode: PAIRING_CODE },
    ...opts,
  });
  let approvalSecret: string | undefined;
  return {
    app,
    db,
    dir,
    repoDir,
    logs,
    call({ key, headers, ...rest }) {
      const method = (rest.method ?? "GET").toUpperCase();
      const h: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
      if (method !== "GET" && method !== "HEAD" && key !== null)
        h["idempotency-key"] = key ?? `k-${++counter}-${Date.now()}`;
      return app.inject({ ...rest, headers: { ...h, ...(headers ?? {}) } });
    },
    async approvalHeaders() {
      if (!approvalSecret) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/approval-session",
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { pairingCode: PAIRING_CODE, channel: "web" },
        });
        approvalSecret = (res.json() as { approvalSecret: string }).approvalSecret;
      }
      return { "x-sindri-approval": approvalSecret };
    },
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}
