import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * `smoke.spec.ts` and `screens.spec.ts` need only Vite; `live.spec.ts` uses the real server from
 * scripts/dev-server.ts (T6 + T7). `flow.spec.ts` also needs T12 orchestration; set MIMIR_E2E=1 to
 * enable it once T12 has landed.
 */
// Set once in the runner; workers inherit it, so the server and the specs agree on the file.
process.env["MIMIR_E2E_INFO"] ??= join(mkdtempSync(join(tmpdir(), "mimir-e2e-info-")), "info.json");
const apiPort = Number(process.env["MIMIR_E2E_PORT"] ?? 7711);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "tsx scripts/dev-server.ts",
      url: `http://127.0.0.1:${apiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { MIMIR_E2E_PORT: String(apiPort), MIMIR_E2E_INFO: process.env["MIMIR_E2E_INFO"] },
    },
    {
      command: "vite --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 60_000,
      env: { MIMIR_URL: `http://127.0.0.1:${apiPort}` },
    },
  ],
});
