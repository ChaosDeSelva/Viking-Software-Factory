import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev server serves the component catalog; vite.lib.config.ts builds the package.
export default defineConfig({
  root: "catalog",
  cacheDir: "../node_modules/.vite",
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 4395 },
  test: {
    root: ".",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
