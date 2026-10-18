// Real Sindri server for the e2e run: temp data dir, FakeProvider with the deterministic demo
// responders (spec + plan), and a fake Mimir (from @sindri/testing) wired through settings.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "@sindri/director";
import { openDatabase } from "@sindri/knowledge";
import { buildServer, demoPlanResponder } from "@sindri/server";
import { createFakeMimir } from "@sindri/testing";

const port = Number(process.env["E2E_API_PORT"] ?? "7891");
const token = process.env["E2E_TOKEN"];
const origin = process.env["E2E_WEB_ORIGIN"];
if (!token || !origin) throw new Error("E2E_TOKEN and E2E_WEB_ORIGIN are required");

// The implementer task asks for one gated action that a human must approve in the UI.
const mimir = await createFakeMimir({
  stepDelayMs: 5,
  scripts: {
    "implement-frontend": [{ kind: "approval", action: "fs.write", reason: "write export.ts" }],
  },
});
const MIMIR_SECRET = "mimir.token";

const dataDir = mkdtempSync(join(tmpdir(), "sindri-e2e-"));
const dbPath = join(dataDir, "sindri.db");
const db = openDatabase(dbPath);
const provider = new FakeProvider(demoPlanResponder());
const app = buildServer({
  db,
  dbPath,
  dataDir,
  authToken: token,
  allowedOrigins: [origin],
  providerFactory: () => provider,
  // Fixed so the flow can unlock approvals (audit M9); production prints a random code.
  // Printed like `sindri start` does, so scripts/qa-smoke.mjs can read it from stdout.
  approval: {
    pairingCode: "E2EPA-IRCDE",
    onPairingCode: (code) => console.log(`sindri approval pairing code: ${code}`),
  },
  secrets: { get: (k) => Promise.resolve(k === MIMIR_SECRET ? mimir.token : undefined) },
});
// Point Sindri at the fake Mimir (loopback, so local-only mode allows it).
const current = await app.inject({
  method: "GET",
  url: "/v1/settings",
  headers: { authorization: `Bearer ${token}` },
});
const configured = await app.inject({
  method: "PUT",
  url: "/v1/settings",
  headers: { authorization: `Bearer ${token}`, "idempotency-key": "e2e-settings" },
  payload: {
    ...(current.json() as { settings: Record<string, unknown> }).settings,
    mimirUrl: mimir.url,
    mimirTokenSecret: MIMIR_SECRET,
  },
});
if (configured.statusCode !== 200) throw new Error(`settings: ${configured.body}`);
await app.listen({ host: "127.0.0.1", port });
console.log(`sindri e2e server on http://127.0.0.1:${port} (data ${dataDir}, mimir ${mimir.url})`);

const stop = async () => {
  await app.close();
  await mimir.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
