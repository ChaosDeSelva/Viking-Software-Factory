import { defineConfig, devices } from "@playwright/test";

const API_PORT = 7891;
const WEB_PORT = 5191;
export const E2E_TOKEN = "e2e-token-0123456789abcdef0123456789abcdef";

export default defineConfig({
  testDir: "e2e",
  // Keep artifacts out of the source tree (and out of prettier/eslint).
  outputDir: "node_modules/.playwright/test-results",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "tsx e2e/server.ts",
      url: `http://127.0.0.1:${API_PORT}/v1/health`,
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        E2E_TOKEN,
      },
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `vite --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { SINDRI_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
