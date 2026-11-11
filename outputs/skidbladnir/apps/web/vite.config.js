import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [tailwindcss()],
  base: './',
  build: {
    rolldownOptions: {
      // Libraries change less often than the app, so they get their own cacheable chunk. The docs
      // package stays out of it: its page text must follow the lazily loaded Docs page.
      output: {
        codeSplitting: {
          groups: [{ name: 'vendor', test: (id) => /node_modules/.test(id) && !/@factory[\\/]docs/.test(id) }],
        },
      },
      // Radix ships "use client" directives; they mean nothing in a client-only bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});
