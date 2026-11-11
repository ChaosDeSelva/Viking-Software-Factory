import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const external = [...Object.keys(pkg.peerDependencies), ...Object.keys(pkg.dependencies)].map(
  (name) => new RegExp(`^${name}(/.*)?$`),
);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
    rolldownOptions: { external },
  },
});
