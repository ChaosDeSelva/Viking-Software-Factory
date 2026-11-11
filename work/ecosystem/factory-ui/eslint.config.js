import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "catalog-dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } } },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      // Apps consume this package as a packed tarball; no reaching into sibling repos.
      "no-restricted-imports": [
        "error",
        { patterns: ["**/sindri/**", "**/mimir/**", "**/heimdall/**", "**/brokkr/**"] },
      ],
    },
  },
);
