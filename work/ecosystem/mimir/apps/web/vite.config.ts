import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In dev the UI talks to the Mimir server through this proxy, so requests are same-origin for the
// browser. `changeOrigin: true` rewrites Host to the target (the server checks Host against its own
// origins); the browser's Origin (http://127.0.0.1:5173) stays and is in the server's default
// MIMIR_ALLOWED_ORIGINS.
const MIMIR_URL = process.env["MIMIR_URL"] ?? "http://127.0.0.1:7700";

export default defineConfig({
  cacheDir: "node_modules/.vite",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/v1": { target: MIMIR_URL, changeOrigin: true } },
  },
  preview: {
    host: "127.0.0.1",
    proxy: { "/v1": { target: MIMIR_URL, changeOrigin: true } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
