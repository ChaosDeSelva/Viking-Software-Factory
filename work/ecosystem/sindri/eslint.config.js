import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** No source or path imports across repos: Mimir and Brokkr are consumed only as packed tarballs. */
const crossRepoPatterns = [
  {
    group: ["**/mimir/**", "**/brokkr/**", "**/upstream/herdr/**", "**/herdr/**"],
    message: "No cross-repo source imports: consume Mimir/Brokkr only through their packed SDKs.",
  },
];

/** Only packages/mimir-client (and the test fake in packages/testing) may touch Mimir's packages. */
const mimirPackagePatterns = [
  {
    group: ["@mimir/*"],
    message: "Only @sindri/mimir-client talks to Mimir (@mimir/sdk, @mimir/protocol).",
  },
];

/**
 * Appended by packages/mimir-client and packages/testing (the Mimir fake), the only places
 * allowed to import @mimir/*. Cross-repo path imports stay forbidden there too.
 */
export const mimirConsumer = {
  files: ["**/*.{ts,tsx,js,mjs}"],
  rules: { "no-restricted-imports": ["error", { patterns: crossRepoPatterns }] },
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "docs/**",
      "harnesses/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [...crossRepoPatterns, ...mimirPackagePatterns] },
      ],
    },
  },
);
