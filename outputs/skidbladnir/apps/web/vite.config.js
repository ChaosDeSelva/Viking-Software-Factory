import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [tailwindcss()],
  base: './',
  build: {
    // One chunk by design: the shared docs (glossary, statuses, screen guides) are most of it.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      // Radix ships "use client" directives; they mean nothing in a client-only bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});
