import root from "../../eslint.config.js";

// Dependency boundary (spec §12.1, ecosystem rules): the SDK may import @brokkr/*
// packages, node built-ins and its third-party dependencies, but nothing from
// Mimir, Sindri or HerdR, and no source paths outside this package.
const FORBIDDEN = ["@mimir/*", "@sindri/*", "mimir", "sindri", "*herdr*", "@herdr/*"];
const message = "The Brokkr SDK must not import Mimir, Sindri, HerdR or another package's sources.";

export default [
  ...root,
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: FORBIDDEN, message },
            { group: ["../../*", "**/mimir/**", "**/sindri/**"], message },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportExpression[source.value=/^(@mimir|@sindri|@herdr)\\/|herdr|\\.\\.\\/\\.\\.\\//]",
          message,
        },
      ],
    },
  },
];
