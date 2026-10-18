import root from "../../eslint.config.js";

// Contract tests are consumers: only the public SDK entry points.
export default [
  ...root,
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@brokkr/*", "!@brokkr/sdk", "!@brokkr/sdk/testing", "../../packages/*"],
              message: "Contract tests consume Brokkr only through @brokkr/sdk.",
            },
          ],
        },
      ],
    },
  },
];
