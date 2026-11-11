import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rolldownOptions: {
      // React and the other libraries change less often than the app: separate cacheable chunks.
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 2,
            },
            { name: "vendor", test: /node_modules/, priority: 1 },
          ],
        },
      },
    },
  },
});
