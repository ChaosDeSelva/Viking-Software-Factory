import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The dev server proxies /v1 to the Sindri API so the browser stays same-origin.
const apiTarget = process.env["SINDRI_API_URL"] ?? "http://127.0.0.1:7800";

export default defineConfig({
  cacheDir: "node_modules/.vite",
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/v1": { target: apiTarget } } },
  preview: { host: "127.0.0.1", proxy: { "/v1": { target: apiTarget } } },
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
